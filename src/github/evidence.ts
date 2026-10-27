import { GitHubError, GitHubRateLimitError, type GitHubClient } from "./client.js";
import { commitsSchema, issueSearchSchema, repoListSchema, repoSchema } from "./types.js";
import type { z } from "zod";

export type EvidenceItem = {
  kind: "merged_pr" | "own_commit" | "own_repo";
  label: string;
  url: string;
};

export type RepoInfo = z.infer<typeof repoSchema>;
export type RepoInfoCache = Map<string, RepoInfo | null>;

export type EvidenceOptions = {
  relevantRepos?: ReadonlySet<string>;
  repoInfo?: RepoInfoCache;
  languages?: readonly string[];
};

const NOT_CODE_LANGUAGES = new Set(["html", "css", "scss", "markdown"]);
const URL_IN_TEXT = /(?:https?:\/\/|www\.)\S+/gi;

export const MIN_REPO_STARS = 5;
const MAX_ITEMS = 5;
const MAX_REPO_LOOKUPS = 5;
const MIN_ITEMS_BEFORE_COMMITS = 3;
const MAX_OWN_COMMITS = 3;
const MAX_OWN_REPOS = 2;

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function clip(s: string, n: number): string {
  const one = s.replace(URL_IN_TEXT, "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function httpsGitHub(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "github.com";
  } catch {
    return false;
  }
}

async function soft<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof GitHubError && !(err instanceof GitHubRateLimitError)) return fallback;
    throw err;
  }
}

function repoLabel(repo: z.infer<typeof repoSchema>): string {
  const details = [repo.language, repo.pushed_at ? `pushed ${repo.pushed_at.slice(0, 7)}` : null].filter(Boolean);
  return details.length > 0 ? `${repo.full_name} (${details.join(", ")})` : repo.full_name;
}

type Pr = { item: EvidenceItem; repo: string };

export async function buildEvidence(
  client: GitHubClient,
  login: string,
  opts: EvidenceOptions = {},
): Promise<EvidenceItem[]> {
  if (!LOGIN.test(login)) return [];
  const relevant = opts.relevantRepos ?? new Set<string>();
  const cache: RepoInfoCache = opts.repoInfo ?? new Map();

  const prs = await soft(
    () =>
      client.getJson(
        "/search/issues",
        { q: `author:${login} is:pr is:merged is:public -user:${login}`, sort: "updated", order: "desc", per_page: 30 },
        issueSearchSchema,
      ),
    { items: [] },
  );
  const merged: Pr[] = prs.items
    .filter((p) => p.pull_request?.merged_at && p.repository?.private !== true && httpsGitHub(p.html_url))
    .map((p) => ({
      repo: p.repository_url.replace(/^.*\/repos\//, ""),
      item: {
        kind: "merged_pr" as const,
        label: `${p.repository_url.replace(/^.*\/repos\//, "")}#${p.number} ${clip(p.title, 90)}`,
        url: p.html_url,
      },
    }))
    .filter(({ repo }) => !repo.toLowerCase().startsWith("triggerdotdev/"));

  const searched = merged.filter(({ repo }) => relevant.has(repo.toLowerCase()));
  const elsewhere = merged.filter(({ repo }) => !relevant.has(repo.toLowerCase()));

  const repos = await soft(
    () => client.getJson(`/users/${login}/repos`, { sort: "pushed", type: "owner", per_page: 30 }, repoListSchema),
    [],
  );
  const wanted = new Set((opts.languages ?? []).map((l) => l.toLowerCase()));
  const siteName = new RegExp(`^${login.replace(/[^A-Za-z0-9-]/g, "")}\\.github\\.io$`, "i");
  const own = repos
    .filter((r) => r.private === false && !r.fork && !r.archived)
    .filter((r) => {
      const name = r.full_name.split("/")[1] ?? "";
      if (siteName.test(name) || /\.github\.io$/i.test(name)) return false;
      const lang = r.language?.toLowerCase();
      return !!lang && !NOT_CODE_LANGUAGES.has(lang);
    })
    .sort((a, b) => {
      const ma = wanted.has(a.language!.toLowerCase()) ? 0 : 1;
      const mb = wanted.has(b.language!.toLowerCase()) ? 0 : 1;
      if (ma !== mb) return ma - mb;
      return (b.pushed_at ?? "").localeCompare(a.pushed_at ?? "");
    })
    .slice(0, MAX_OWN_REPOS);
  const ownItems: EvidenceItem[] = own
    .filter((r) => r.html_url && httpsGitHub(r.html_url))
    .map((r) => ({ kind: "own_repo" as const, label: repoLabel(r), url: r.html_url! }));

  const haveAnchor = searched.length + ownItems.length > 0;
  const distinct = [...new Set(elsewhere.map(({ repo }) => repo.toLowerCase()))];
  let lookups = 0;
  for (const key of distinct) {
    if (cache.has(key)) continue;
    if (lookups >= MAX_REPO_LOOKUPS) break;
    lookups++;
    const fullName = elsewhere.find(({ repo }) => repo.toLowerCase() === key)!.repo;
    cache.set(key, await soft(() => client.getJson(`/repos/${fullName}`, {}, repoSchema), null));
  }

  const ranked = elsewhere
    .map((pr) => ({ pr, info: cache.get(pr.repo.toLowerCase()) ?? null }))
    .filter(({ info }) => {
      if (!info) return true;
      if (info.private === true || info.fork || info.archived) return false;
      if (haveAnchor && (info.stargazers_count ?? Infinity) < MIN_REPO_STARS) return false;
      return true;
    })
    .sort((a, b) => {
      const sa = a.info?.stargazers_count;
      const sb = b.info?.stargazers_count;
      if (sa === undefined && sb === undefined) return 0;
      if (sa === undefined) return 1;
      if (sb === undefined) return -1;
      return sb - sa;
    })
    .map(({ pr }) => pr.item);

  const items = [...searched.map((p) => p.item), ...ownItems, ...ranked].slice(0, MAX_ITEMS);

  if (items.length >= MIN_ITEMS_BEFORE_COMMITS) return items;

  const lower = login.toLowerCase();
  let commitCount = 0;
  for (const repo of own) {
    const commits = await soft(
      () => client.getJson(`/repos/${repo.full_name}/commits`, { per_page: 100 }, commitsSchema),
      [],
    );
    const mine = commits.filter((c) => c.author?.login.toLowerCase() === lower && httpsGitHub(c.html_url));
    for (const c of mine) {
      if (commitCount >= MAX_OWN_COMMITS || items.length >= MAX_ITEMS) break;
      const first = c.commit.message.split("\n")[0] ?? "";
      items.push({ kind: "own_commit", label: `${repo.full_name}: ${clip(first, 90)}`, url: c.html_url });
      commitCount++;
    }
  }
  return items;
}
