import { describe, expect, it } from "vitest";
import { buildEvidence } from "../src/github/evidence.js";
import { GitHubError, GitHubRateLimitError } from "../src/github/client.js";
import { findCandidates } from "../src/github/sourcing.js";
import { demoConfigFromEnv } from "../src/outreach/demo.js";
import { contributor, fakeClient, mergedPr, noDemo, profile } from "./fakeGithub.js";

const noBlocked = async () => ({ suppressed: new Set<number>(), live: new Set<number>() });

describe("buildEvidence", () => {
  it("returns merged PRs from other repos, relevant repos first, https only, max 5", async () => {
    const prs = [
      mergedPr("other/zeta", 1),
      mergedPr("other/zeta", 2),
      mergedPr("seed/alpha", 3, "Relevant change"),
      mergedPr("other/zeta", 4),
      mergedPr("other/zeta", 5),
      mergedPr("other/zeta", 6),
      mergedPr("triggerdotdev/trigger.dev", 7),
      { ...mergedPr("other/zeta", 8), html_url: "http://github.com/other/zeta/pull/8" },
      { ...mergedPr("other/zeta", 9), pull_request: { merged_at: null } },
    ];
    const client = fakeClient({ "/search/issues": { items: prs } });
    const ev = await buildEvidence(client, "fake-dev-one", { relevantRepos: new Set(["seed/alpha"]) });
    expect(ev).toHaveLength(5);
    expect(ev[0]).toMatchObject({ kind: "merged_pr", url: "https://github.com/seed/alpha/pull/3" });
    expect(ev.every((e) => e.url.startsWith("https://github.com/"))).toBe(true);
    expect(ev.some((e) => e.label.includes("triggerdotdev"))).toBe(false);
    expect(ev.some((e) => e.url.includes("/pull/8") || e.url.includes("/pull/9"))).toBe(false);
  });

  it("uses own-repo commits, filtered client-side by author login, when PRs are few", async () => {
    const commit = (sha: string, login: string | null, msg: string) => ({
      sha,
      html_url: `https://github.com/fake-dev-one/fake-repo/commit/${sha}`,
      commit: { message: msg, author: { date: "2026-10-01T00:00:00Z" } },
      author: login ? { login } : null,
    });
    const client = fakeClient({
      "/search/issues": { items: [mergedPr("other/zeta", 1)] },
      "/users/fake-dev-one/repos": [
        { full_name: "fake-dev-one/forked", fork: true, private: false, html_url: "https://github.com/fake-dev-one/forked" },
        { full_name: "fake-dev-one/fake-repo", language: "Go", fork: false, private: false, html_url: "https://github.com/fake-dev-one/fake-repo" },
      ],
      "/repos/fake-dev-one/fake-repo/commits": [
        commit("a1", "someone-else", "not mine"),
        commit("b2", "Fake-Dev-One", "Add queue worker\n\nbody"),
        commit("c3", null, "unattributed"),
        commit("d4", "fake-dev-one", "Fix retry"),
      ],
    });
    const ev = await buildEvidence(client, "fake-dev-one");
    expect(ev.map((e) => e.kind)).toEqual(["own_repo", "merged_pr", "own_commit", "own_commit"]);
    expect(ev[0]?.label).toBe("fake-dev-one/fake-repo (Go)");
    expect(ev[2]?.label).toBe("fake-dev-one/fake-repo: Add queue worker");
    expect(client.calls.find((c) => c.path.endsWith("/commits"))?.params).not.toHaveProperty("author");
    expect(client.calls.some((c) => c.path.includes("forked"))).toBe(false);
  });

  it("labels own repos with language and last push month, newest first, skipping forks and archived", async () => {
    const client = fakeClient({
      "/search/issues": { items: [] },
      "/users/fake-dev-one/repos": [
        { full_name: "fake-dev-one/old", language: "Go", private: false, pushed_at: "2025-01-05T00:00:00Z", html_url: "https://github.com/fake-dev-one/old" },
        { full_name: "fake-dev-one/newest", language: "TypeScript", private: false, pushed_at: "2026-10-26T10:00:00Z", html_url: "https://github.com/fake-dev-one/newest" },
        { full_name: "fake-dev-one/archived", private: false, archived: true, pushed_at: "2026-10-27T00:00:00Z", html_url: "https://github.com/fake-dev-one/archived" },
        { full_name: "fake-dev-one/fork", private: false, fork: true, pushed_at: "2026-10-27T00:00:00Z", html_url: "https://github.com/fake-dev-one/fork" },
        { full_name: "fake-dev-one/third", language: "Rust", private: false, pushed_at: "2024-01-01T00:00:00Z", html_url: "https://github.com/fake-dev-one/third" },
      ],
      "/repos/fake-dev-one/newest/commits": [],
      "/repos/fake-dev-one/old/commits": [],
    });
    const ev = await buildEvidence(client, "fake-dev-one");
    expect(ev.map((e) => e.label)).toEqual([
      "fake-dev-one/newest (TypeScript, pushed 2026-10)",
      "fake-dev-one/old (Go, pushed 2025-01)",
    ]);
  });

  it("falls back to a repo item when no own commits are visible", async () => {
    const client = fakeClient({
      "/search/issues": { items: [] },
      "/users/fake-dev-one/repos": [
        { full_name: "fake-dev-one/fake-repo", language: "Go", private: false, html_url: "https://github.com/fake-dev-one/fake-repo" },
      ],
      "/repos/fake-dev-one/fake-repo/commits": [],
    });
    const ev = await buildEvidence(client, "fake-dev-one");
    expect(ev).toEqual([
      { kind: "own_repo", label: "fake-dev-one/fake-repo (Go)", url: "https://github.com/fake-dev-one/fake-repo" },
    ]);
  });

  it("skips repos whose commits 409 or 404, and refuses unsafe logins", async () => {
    const client = fakeClient({
      "/search/issues": { items: [] },
      "/users/fake-dev-one/repos": [{ full_name: "fake-dev-one/empty", language: "Go", private: false, html_url: "https://github.com/fake-dev-one/empty" }],
      "/repos/fake-dev-one/empty/commits": new GitHubError(409, "empty"),
    });
    expect((await buildEvidence(client, "fake-dev-one"))[0]?.kind).toBe("own_repo");
    expect(await buildEvidence(client, "bad login author:x")).toEqual([]);
  });

  describe("own repo relevance", () => {
    const repo = (name: string, language: string | null, pushed: string, extra: object = {}) => ({
      full_name: `fake-dev-one/${name}`,
      ...(language ? { language } : {}),
      private: false,
      pushed_at: pushed,
      html_url: `https://github.com/fake-dev-one/${name}`,
      ...extra,
    });
    const run = (repos: unknown[], languages?: string[]) =>
      buildEvidence(
        fakeClient({
          "/search/issues": { items: [] },
          "/users/fake-dev-one/repos": repos,
          "/repos/fake-dev-one/a/commits": [],
          "/repos/fake-dev-one/b/commits": [],
          "/repos/fake-dev-one/c/commits": [],
        }),
        "fake-dev-one",
        { languages },
      );

    it("skips personal sites, HTML and other non-code repos, repos without a language, forks and archived", async () => {
      const ev = await run([
        repo("fake-dev-one.github.io", "TypeScript", "2026-10-26T00:00:00Z"),
        repo("blog.github.io", "TypeScript", "2026-10-26T00:00:00Z"),
        repo("landing", "HTML", "2026-10-26T00:00:00Z"),
        repo("styles", "CSS", "2026-10-26T00:00:00Z"),
        repo("theme", "SCSS", "2026-10-26T00:00:00Z"),
        repo("notes", "Markdown", "2026-10-26T00:00:00Z"),
        repo("nolang", null, "2026-10-26T00:00:00Z"),
        repo("forked", "Go", "2026-10-26T00:00:00Z", { fork: true }),
        repo("old", "Go", "2026-10-26T00:00:00Z", { archived: true }),
        repo("a", "Go", "2026-01-01T00:00:00Z"),
      ]);
      expect(ev.map((e) => e.label)).toEqual(["fake-dev-one/a (Go, pushed 2026-01)"]);
    });

    it("ranks repos in the searched languages first, then by recency", async () => {
      const ev = await run(
        [repo("a", "TypeScript", "2026-10-26T00:00:00Z"), repo("b", "Go", "2025-03-01T00:00:00Z"), repo("c", "go", "2024-03-01T00:00:00Z")],
        ["Go"],
      );
      expect(ev.map((e) => e.label)).toEqual(["fake-dev-one/b (Go, pushed 2025-03)", "fake-dev-one/c (go, pushed 2024-03)"]);
    });

    it("falls back to the newest two when no repo matches the searched languages", async () => {
      const ev = await run(
        [repo("a", "TypeScript", "2026-10-26T00:00:00Z"), repo("b", "Python", "2026-05-01T00:00:00Z"), repo("c", "Rust", "2024-03-01T00:00:00Z")],
        ["Go"],
      );
      expect(ev.map((e) => e.label)).toEqual([
        "fake-dev-one/a (TypeScript, pushed 2026-10)",
        "fake-dev-one/b (Python, pushed 2026-05)",
      ]);
    });

    it("uses recency alone when no languages are given", async () => {
      const ev = await run([repo("b", "Go", "2025-03-01T00:00:00Z"), repo("a", "TypeScript", "2026-10-26T00:00:00Z")]);
      expect(ev[0]?.label).toBe("fake-dev-one/a (TypeScript, pushed 2026-10)");
    });

    it("findCandidates passes the searched languages to the evidence builder", async () => {
      const client = fakeClient({
        "/orgs/triggerdotdev/public_members": [],
        "/repos/triggerdotdev/trigger.dev/contributors": [],
        "/repos/seed/go/contributors": [contributor(1, "fake-dev-one", 5)],
        "/users/fake-dev-one": profile(1, "fake-dev-one", { email: "fake@example.test" }),
        "/search/issues": { items: [] },
        "/users/fake-dev-one/repos": [repo("a", "TypeScript", "2026-10-26T00:00:00Z"), repo("b", "Go", "2024-03-01T00:00:00Z")],
        "/repos/fake-dev-one/a/commits": [],
        "/repos/fake-dev-one/b/commits": [],
      });
      const result = await findCandidates(
        { client, blocked: noBlocked, demo: noDemo, seeds: [{ repo: "seed/go", language: "Go" }] },
        { query: "go engineers", languages: ["Go"] },
      );
      expect(result.candidates[0]?.evidence[0]?.label).toBe("fake-dev-one/b (Go, pushed 2024-03)");
    });

    it("scrubs URLs out of PR title labels", async () => {
      const ev = await buildEvidence(
        fakeClient({
          "/search/issues": { items: [mergedPr("seed/alpha", 1, "Fix docs at https://example.test/guide and www.example.test/x ok")] },
          "/users/fake-dev-one/repos": [],
        }),
        "fake-dev-one",
        { relevantRepos: new Set(["seed/alpha"]) },
      );
      expect(ev[0]?.label).toBe("seed/alpha#1 Fix docs at and ok");
    });
  });

  describe("ranking", () => {
    const own = {
      full_name: "fake-dev-one/agentflow",
      language: "Go",
      private: false,
      pushed_at: "2026-10-26T00:00:00Z",
      html_url: "https://github.com/fake-dev-one/agentflow",
    };
    const repoInfo = (full_name: string, stars: number, extra: object = {}) => ({ full_name, stargazers_count: stars, ...extra });
    const base = (): Record<string, unknown> => ({
      "/search/issues": {
        items: [
          mergedPr("tutorial/zero", 1, "Add my name"),
          mergedPr("big/popular", 2, "Popular fix"),
          mergedPr("mid/library", 3, "Library fix"),
          mergedPr("seed/alpha", 4, "Searched repo fix"),
          mergedPr("unknown/repo", 5, "Unknown stars"),
          mergedPr("some/fork", 6, "Fork PR"),
          mergedPr("old/archived", 7, "Archived PR"),
        ],
      },
      "/users/fake-dev-one/repos": [own],
      "/repos/fake-dev-one/agentflow/commits": [],
      "/repos/tutorial/zero": repoInfo("tutorial/zero", 0),
      "/repos/big/popular": repoInfo("big/popular", 9000),
      "/repos/mid/library": repoInfo("mid/library", 40),
      "/repos/some/fork": repoInfo("some/fork", 500, { fork: true }),
      "/repos/old/archived": repoInfo("old/archived", 500, { archived: true }),
    });

    it("orders searched-repo PRs, then own repos, then other PRs by stars; drops low-star, fork and archived", async () => {
      const client = fakeClient(base());
      const ev = await buildEvidence(client, "fake-dev-one", { relevantRepos: new Set(["seed/alpha"]) });
      expect(ev.map((e) => e.label)).toEqual([
        "seed/alpha#4 Searched repo fix",
        "fake-dev-one/agentflow (Go, pushed 2026-10)",
        "big/popular#2 Popular fix",
        "mid/library#3 Library fix",
        "unknown/repo#5 Unknown stars",
      ]);
      expect(ev.some((e) => /tutorial|some\/fork|old\/archived/.test(e.label))).toBe(false);
    });

    it("keeps a repo whose lookup failed and never drops on missing data", async () => {
      const routes = base();
      delete routes["/repos/tutorial/zero"];
      const client = fakeClient(routes);
      const ev = await buildEvidence(client, "fake-dev-one", { relevantRepos: new Set() });
      expect(ev.map((e) => e.label)).toContain("tutorial/zero#1 Add my name");
    });

    it("keeps low-star repos when there is no searched PR and no own repo", async () => {
      const routes = base();
      routes["/users/fake-dev-one/repos"] = [];
      const client = fakeClient(routes);
      const ev = await buildEvidence(client, "fake-dev-one", { relevantRepos: new Set() });
      expect(ev.map((e) => e.label)).toContain("tutorial/zero#1 Add my name");
      expect(ev[0]?.label).toBe("big/popular#2 Popular fix");
    });

    it("looks up each distinct repo at most once, at most 5 per call, and shares a cache across calls", async () => {
      const many = Array.from({ length: 8 }, (_, i) => mergedPr(`org${i}/lib`, i + 1, `Fix ${i}`));
      const routes: Record<string, unknown> = { "/search/issues": { items: many }, "/users/fake-dev-one/repos": [] };
      for (let i = 0; i < 8; i++) routes[`/repos/org${i}/lib`] = repoInfo(`org${i}/lib`, 100 + i);
      const client = fakeClient(routes);
      const cache = new Map();
      await buildEvidence(client, "fake-dev-one", { repoInfo: cache });
      const lookups = client.calls.filter((c) => c.path.startsWith("/repos/")).length;
      expect(lookups).toBe(5);
      await buildEvidence(client, "fake-dev-one", { repoInfo: cache });
      expect(client.calls.filter((c) => c.path.startsWith("/repos/")).length).toBeLessThanOrEqual(8);
    });

    it("caps the list at 5 and adds own commits only while fewer than 3 items exist", async () => {
      const routes = base();
      routes["/repos/fake-dev-one/agentflow/commits"] = [
        { sha: "a1", html_url: "https://github.com/fake-dev-one/agentflow/commit/a1", commit: { message: "Add thing" }, author: { login: "fake-dev-one" } },
      ];
      const full = await buildEvidence(fakeClient(routes), "fake-dev-one", { relevantRepos: new Set(["seed/alpha"]) });
      expect(full).toHaveLength(5);
      expect(full.some((e) => e.kind === "own_commit")).toBe(false);

      const sparse = base();
      sparse["/search/issues"] = { items: [] };
      sparse["/repos/fake-dev-one/agentflow/commits"] = routes["/repos/fake-dev-one/agentflow/commits"];
      const few = await buildEvidence(fakeClient(sparse), "fake-dev-one");
      expect(few.map((e) => e.kind)).toEqual(["own_repo", "own_commit"]);
    });
  });

  it("asks GitHub for public items only and drops private ones even if returned", async () => {
    const commit = (sha: string) => ({
      sha,
      html_url: `https://github.com/fake-dev-one/public-repo/commit/${sha}`,
      commit: { message: "Public commit", author: null },
      author: { login: "fake-dev-one" },
    });
    const client = fakeClient({
      "/search/issues": {
        items: [
          { ...mergedPr("fake-org-private/backend", 1, "Secret roadmap"), repository: { private: true } },
          mergedPr("fake-org-public/lib", 2, "Public fix"),
        ],
      },
      "/users/fake-dev-one/repos": [
        { full_name: "fake-dev-one/private-repo", private: true, html_url: "https://github.com/fake-dev-one/private-repo" },
        { full_name: "fake-dev-one/unknown-visibility", html_url: "https://github.com/fake-dev-one/unknown-visibility" },
        { full_name: "fake-dev-one/public-repo", language: "Go", private: false, html_url: "https://github.com/fake-dev-one/public-repo" },
      ],
      "/repos/fake-dev-one/public-repo/commits": [commit("p1")],
      "/repos/fake-dev-one/private-repo/commits": [commit("s1")],
      "/repos/fake-dev-one/unknown-visibility/commits": [commit("u1")],
    });
    const ev = await buildEvidence(client, "fake-dev-one");
    const text = JSON.stringify(ev);
    expect(text).not.toContain("private");
    expect(text).not.toContain("Secret roadmap");
    expect(text).toContain("Public fix");
    expect(text).toContain("public-repo");
    expect(client.calls.some((c) => c.path.includes("private-repo") || c.path.includes("unknown-visibility"))).toBe(false);
    const search = client.calls.find((c) => c.path === "/search/issues");
    expect(String((search?.params as { q: string }).q)).toContain("is:public");
  });

  it("propagates rate-limit errors but swallows other GitHub errors", async () => {
    const limited = fakeClient({ "/search/issues": new GitHubRateLimitError(403, "limit") });
    await expect(buildEvidence(limited, "fake-dev-one")).rejects.toBeInstanceOf(GitHubRateLimitError);
    const broken = fakeClient({ "/search/issues": new GitHubError(500, "boom") });
    await expect(buildEvidence(broken, "fake-dev-one")).resolves.toEqual([]);
  });
});

const routes = () => ({
  "/orgs/triggerdotdev/public_members": [{ id: 100, login: "Fake-Trigger-Member" }],
  "/repos/triggerdotdev/trigger.dev/contributors": [contributor(101, "fake-trigger-top")],
  "/repos/seed/alpha/contributors": [
    contributor(1, "fake-dev-one", 50),
    contributor(2, "fake-dev-two", 40),
    contributor(3, "ci-bot[bot]", 99, "Bot"),
    contributor(100, "fake-trigger-member", 30),
    contributor(101, "fake-trigger-top", 30),
    contributor(4, "fake-bio-trigger", 20),
    contributor(5, "fake-org", 20),
    contributor(6, "fake-suppressed", 20),
    contributor(7, "fake-live", 20),
  ],
  "/repos/seed/beta/contributors": [contributor(1, "fake-dev-one", 5), contributor(8, "fake-dev-three", 3)],
  "/users/fake-dev-one": profile(1, "fake-dev-one", { email: "fake.one@example.test", name: "Fake One" }),
  "/users/fake-dev-two": profile(2, "fake-dev-two", { twitter_username: "fake_two" }),
  "/users/fake-dev-three": profile(8, "fake-dev-three", { email: "fake.three@example.test" }),
  "/users/fake-bio-trigger": profile(4, "fake-bio-trigger", { bio: "Engineer at trigger.dev" }),
  "/users/fake-org": profile(5, "fake-org", { type: "Organization" }),
  "/users/fake-suppressed": profile(6, "fake-suppressed"),
  "/users/fake-live": profile(7, "fake-live"),
  "/search/issues": { items: [mergedPr("seed/alpha", 11), mergedPr("other/x", 12), mergedPr("other/x", 13)] },
});

const seeds = [
  { repo: "seed/alpha", language: "TypeScript" },
  { repo: "seed/beta", language: "TypeScript" },
  { repo: "seed/gamma", language: "TypeScript" },
  { repo: "seed/go", language: "Go" },
];

describe("findCandidates", () => {
  it("filters bots, trigger.dev people, bio mentions, orgs, suppressed and live; dedups by id", async () => {
    const client = fakeClient({
      ...routes(),
      "/repos/seed/gamma/contributors": [],
    });
    const result = await findCandidates(
      {
        client,
        blocked: async () => ({ suppressed: new Set([6]), live: new Set([7]) }),
        demo: noDemo,
        seeds,
      },
      { query: "backend engineers for agent infra", languages: ["TypeScript"], count: 3 },
    );
    const logins = result.candidates.map((c) => c.login);
    expect(logins.sort()).toEqual(["fake-dev-one", "fake-dev-three", "fake-dev-two"]);
    expect(result.excluded).toMatchObject({
      bot: 1,
      triggerdotdev_person: 2,
      organization: 1,
      mentions_triggerdotdev: 1,
      suppressed: 1,
      already_contacted: 1,
    });
    const one = result.candidates.find((c) => c.login === "fake-dev-one");
    expect(one?.contributedTo).toEqual(["seed/alpha", "seed/beta"]);
    expect(one?.contactRoutes[0]).toMatchObject({ channel: "email", provenance: "email published on GitHub profile" });
    expect(one?.evidence.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(/score|rank|contributions/i);
  });

  it("lists candidates with an email route first and honours count", async () => {
    const client = fakeClient({ ...routes(), "/repos/seed/gamma/contributors": [] });
    const result = await findCandidates(
      { client, blocked: noBlocked, demo: noDemo, seeds },
      { query: "backend engineers", languages: ["TypeScript"], count: 2 },
    );
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((c) => c.contactRoutes.some((r) => r.channel === "email"))).toBe(true);
  });

  it("applies the demo login allowlist before any profile is fetched", async () => {
    const client = fakeClient({ ...routes(), "/repos/seed/gamma/contributors": [] });
    const demo = demoConfigFromEnv({ DEMO_MODE: "true", DEMO_ALLOWED_LOGINS: "fake-dev-two" });
    const result = await findCandidates(
      { client, blocked: noBlocked, demo, seeds },
      { query: "backend engineers", languages: ["TypeScript"] },
    );
    expect(result.candidates.map((c) => c.login)).toEqual(["fake-dev-two"]);
    const profileCalls = client.calls.map((c) => c.path).filter((p) => /^\/users\/[^/]+$/.test(p));
    expect(profileCalls).toEqual(["/users/fake-dev-two"]);
    expect(result.excluded.demo_not_allowed).toBeGreaterThan(0);
  });

  it("selects seeds by language and supplements with a repository search when few match", async () => {
    const client = fakeClient({
      ...routes(),
      "/search/repositories": {
        items: [
          { full_name: "triggerdotdev/trigger.dev", language: "Go" },
          { full_name: "seed/extra", language: "Go", archived: false, fork: false },
          { full_name: "seed/archived", language: "Go", archived: true },
          { full_name: "seed/private-extra", language: "Go", private: true },
        ],
      },
      "/repos/seed/go/contributors": [contributor(1, "fake-dev-one", 5)],
      "/repos/seed/extra/contributors": [contributor(2, "fake-dev-two", 5)],
    });
    const result = await findCandidates(
      { client, blocked: noBlocked, demo: noDemo, seeds, now: () => new Date("2026-10-27T00:00:00Z") },
      { query: "go engineers", languages: ["Go"], keywords: ["agents"] },
    );
    expect(result.reposConsidered).toEqual(["seed/go", "seed/extra"]);
    const search = client.calls.find((c) => c.path === "/search/repositories");
    expect(String((search?.params as { q: string }).q)).toContain("language:Go");
    expect(String((search?.params as { q: string }).q)).toContain("pushed:>2026-04-30");
    expect(String((search?.params as { q: string }).q)).toContain("is:public");
    expect(result.reposConsidered).not.toContain("seed/private-extra");
  });

  it("fails when the trigger.dev exclusion lists cannot be fetched", async () => {
    const client = fakeClient({ "/orgs/triggerdotdev/public_members": new GitHubError(500, "boom") });
    await expect(
      findCandidates({ client, blocked: noBlocked, demo: noDemo, seeds }, { query: "backend engineers" }),
    ).rejects.toBeInstanceOf(GitHubError);
  });
});
