import type { z } from "zod";
import { GitHubError, type GitHubClient } from "../src/github/client.js";

export type Routes = Record<string, unknown>;

export function fakeClient(routes: Routes): GitHubClient & { calls: { path: string; params: object }[] } {
  const calls: { path: string; params: object }[] = [];
  return {
    calls,
    async getJson<S extends z.ZodType>(path: string, params: object, schema: S): Promise<z.output<S>> {
      calls.push({ path, params });
      if (!(path in routes)) throw new GitHubError(404, `not found ${path}`);
      const value = routes[path];
      if (value instanceof Error) throw value;
      return schema.parse(value);
    },
  };
}

export const contributor = (id: number, login: string, contributions = 10, type = "User") => ({
  id,
  login,
  type,
  contributions,
});

export const profile = (id: number, login: string, over: Record<string, unknown> = {}) => ({
  id,
  login,
  type: "User",
  name: null,
  email: null,
  twitter_username: null,
  blog: "",
  bio: null,
  company: null,
  ...over,
});

export const mergedPr = (repo: string, number: number, title = "Fix a thing") => ({
  number,
  title,
  html_url: `https://github.com/${repo}/pull/${number}`,
  repository_url: `https://api.github.com/repos/${repo}`,
  pull_request: { merged_at: "2026-10-01T00:00:00Z" },
});

export const noDemo = { enabled: false, allowedLogins: [], allowedRecipients: [], sendMode: "allowlist" as const };
