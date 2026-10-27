import { z } from "zod";
import type { BlockedIds } from "../db/queries.js";
import type { DemoConfig } from "../outreach/demo.js";
import { GitHubError, type GitHubClient } from "./client.js";
import { contactRoutes, type ContactRoute } from "./contact.js";
import { buildEvidence, type EvidenceItem, type RepoInfoCache } from "./evidence.js";
import { excludeReason, type ExcludeReason, type FilterContext } from "./filters.js";
import { SEED_REPOS, type Seed } from "./seeds.js";
import {
  contributorsSchema,
  membersSchema,
  repoSearchSchema,
  userSchema,
  type Contributor,
} from "./types.js";

export const searchParams = z.object({
  query: z.string().min(3).max(300),
  languages: z.array(z.string().min(1).max(30)).max(3).optional(),
  keywords: z.array(z.string().min(1).max(40)).max(4).optional(),
  count: z.number().int().min(1).max(3).default(3),
});
export type SearchParams = z.input<typeof searchParams>;

export type Candidate = {
  githubUserId: number;
  login: string;
  name: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  profileUrl: string;
  contributedTo: string[];
  evidence: EvidenceItem[];
  contactRoutes: ContactRoute[];
};

export type SearchResult = {
  candidates: Candidate[];
  reposConsidered: string[];
  excluded: Partial<Record<ExcludeReason, number>>;
};

export type SourcingDeps = {
  client: GitHubClient;
  blocked: (githubUserIds: number[]) => Promise<BlockedIds>;
  demo: DemoConfig;
  seeds?: readonly Seed[];
  now?: () => Date;
};

const hasEmail = (c: Candidate) => c.contactRoutes.some((r) => r.channel === "email");

const MAX_REPOS = 5;
const CONTRIBUTORS_PER_REPO = 8;
const MAX_PROFILES = 10;
const TRIGGER_TOP_CONTRIBUTORS = 25;
const SEED_MIN = 3;

export async function triggerDevPeople(client: GitHubClient): Promise<Set<string>> {
  const [members, top] = await Promise.all([
    client.getJson("/orgs/triggerdotdev/public_members", { per_page: 100 }, membersSchema),
    client.getJson(
      "/repos/triggerdotdev/trigger.dev/contributors",
      { per_page: TRIGGER_TOP_CONTRIBUTORS },
      contributorsSchema,
    ),
  ]);
  return new Set([...members, ...top].map((p) => p.login.toLowerCase()));
}

async function pickRepos(deps: SourcingDeps, params: z.output<typeof searchParams>): Promise<string[]> {
  const langs = (params.languages ?? []).map((l) => l.toLowerCase());
  const seeds = (deps.seeds ?? SEED_REPOS).filter(
    (s) => langs.length === 0 || langs.includes(s.language.toLowerCase()),
  );
  const repos = seeds.slice(0, MAX_REPOS).map((s) => s.repo);
  if (repos.length >= SEED_MIN) return repos;

  const since = new Date((deps.now?.() ?? new Date()).getTime() - 180 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const parts = [
    ...(params.keywords ?? []),
    "is:public",
    "stars:>300",
    "archived:false",
    "fork:false",
    `pushed:>${since}`,
  ];
  const lang = params.languages?.[0];
  if (lang) parts.push(`language:${lang}`);
  try {
    const found = await deps.client.getJson(
      "/search/repositories",
      { q: parts.join(" "), sort: "stars", order: "desc", per_page: MAX_REPOS },
      repoSearchSchema,
    );
    for (const r of found.items) {
      if (r.archived || r.fork || r.private === true || r.full_name.toLowerCase().startsWith("triggerdotdev/")) continue;
      if (!repos.includes(r.full_name)) repos.push(r.full_name);
      if (repos.length >= MAX_REPOS) break;
    }
  } catch (err) {
    if (!(err instanceof GitHubError) || err.status === 429) throw err;
  }
  return repos;
}

export async function findCandidates(deps: SourcingDeps, input: SearchParams): Promise<SearchResult> {
  const params = searchParams.parse(input);
  const excludedLogins = await triggerDevPeople(deps.client);
  const repos = await pickRepos(deps, params);

  const pool = new Map<number, { c: Contributor; repos: string[] }>();
  for (const repo of repos) {
    let list: Contributor[] = [];
    try {
      list = await deps.client.getJson(
        `/repos/${repo}/contributors`,
        { per_page: CONTRIBUTORS_PER_REPO },
        contributorsSchema,
      );
    } catch (err) {
      if (!(err instanceof GitHubError) || err.status === 429 || err.status === 403) throw err;
    }
    for (const c of list) {
      const hit = pool.get(c.id);
      if (hit) hit.repos.push(repo);
      else pool.set(c.id, { c, repos: [repo] });
    }
  }

  const blocked = await deps.blocked([...pool.keys()]);
  const ctx: FilterContext = {
    excludedLogins,
    suppressedIds: blocked.suppressed,
    liveIds: blocked.live,
    demo: deps.demo,
  };
  const excluded: SearchResult["excluded"] = {};
  const count = (r: ExcludeReason) => {
    excluded[r] = (excluded[r] ?? 0) + 1;
  };

  const eligible = [...pool.values()]
    .filter(({ c }) => {
      const reason = excludeReason(c, ctx);
      if (reason) count(reason);
      return reason === null;
    })
    .sort((a, b) => b.c.contributions - a.c.contributions)
    .slice(0, MAX_PROFILES);

  const relevantRepos = new Set(repos.map((r) => r.toLowerCase()));
  const repoInfo: RepoInfoCache = new Map();
  const withProfile: Candidate[] = [];
  for (const { c, repos: contributedTo } of eligible) {
    if (withProfile.filter(hasEmail).length >= params.count) break;
    const user = await deps.client.getJson(`/users/${c.login}`, {}, userSchema);
    const reason = excludeReason(user, ctx);
    if (reason) {
      count(reason);
      continue;
    }
    const evidence = await buildEvidence(deps.client, user.login, { relevantRepos, repoInfo, languages: params.languages });
    withProfile.push({
      githubUserId: user.id,
      login: user.login,
      name: user.name ?? null,
      bio: user.bio ?? null,
      company: user.company ?? null,
      location: user.location ?? null,
      profileUrl: `https://github.com/${user.login}`,
      contributedTo,
      evidence,
      contactRoutes: contactRoutes(user),
    });
  }

  const ordered = [...withProfile.filter(hasEmail), ...withProfile.filter((c) => !hasEmail(c))];
  return { candidates: ordered.slice(0, params.count), reposConsidered: repos, excluded };
}
