import type { z } from "zod";

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

export class GitHubRateLimitError extends GitHubError {
  readonly resetAt?: Date;
  constructor(status: number, message: string, resetAt?: Date) {
    super(status, message);
    this.name = "GitHubRateLimitError";
    this.resetAt = resetAt;
  }
}

export type GitHubClient = {
  getJson<S extends z.ZodType>(
    path: string,
    params: Record<string, string | number | undefined>,
    schema: S,
  ): Promise<z.output<S>>;
};

export type ClientOptions = {
  token?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  baseUrl?: string;
  maxBackoffMs?: number;
  searchPerMinute?: number;
};

const API = "https://api.github.com";

export function createGitHubClient(opts: ClientOptions = {}): GitHubClient {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const base = opts.baseUrl ?? API;
  const maxBackoff = opts.maxBackoffMs ?? 60_000;
  const searchLimit = opts.searchPerMinute ?? 30;
  const searchTimes: number[] = [];

  async function throttleSearch(): Promise<void> {
    for (;;) {
      const t = now();
      while (searchTimes.length > 0 && t - (searchTimes[0] as number) >= 60_000) searchTimes.shift();
      if (searchTimes.length < searchLimit) {
        searchTimes.push(t);
        return;
      }
      await sleep(60_000 - (t - (searchTimes[0] as number)) + 5);
    }
  }

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "scout-agent",
    };
    if (opts.token) h.authorization = `Bearer ${opts.token}`;
    return h;
  }

  function backoffMs(res: Response): { ms: number; resetAt?: Date } | null {
    if (res.status !== 403 && res.status !== 429) return null;
    const retryAfter = res.headers.get("retry-after");
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    const resetAt = reset ? new Date(Number(reset) * 1000) : undefined;
    if (retryAfter && Number.isFinite(Number(retryAfter))) return { ms: Number(retryAfter) * 1000, resetAt };
    if (remaining === "0" && resetAt) return { ms: Math.max(0, resetAt.getTime() - now()) + 1000, resetAt };
    if (res.status === 429) return { ms: 60_000, resetAt };
    return null;
  }

  return {
    async getJson(path, params, schema) {
      const url = new URL(path, base);
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
      const isSearch = path.startsWith("/search/");
      for (let attempt = 0; attempt < 2; attempt++) {
        if (isSearch) await throttleSearch();
        const res = await doFetch(url, { headers: headers() });
        const wait = backoffMs(res);
        if (wait) {
          if (attempt === 0 && wait.ms <= maxBackoff) {
            await sleep(wait.ms);
            continue;
          }
          throw new GitHubRateLimitError(
            res.status,
            `GitHub rate limit hit on ${path}${wait.resetAt ? `, resets at ${wait.resetAt.toISOString()}` : ""}`,
            wait.resetAt,
          );
        }
        if (!res.ok) throw new GitHubError(res.status, `GitHub request failed on ${path}: ${res.status}`);
        const parsed = schema.safeParse(await res.json());
        if (!parsed.success) throw new GitHubError(502, `GitHub returned an unexpected shape on ${path}`);
        return parsed.data;
      }
      throw new GitHubRateLimitError(429, `GitHub rate limit hit on ${path}`);
    },
  };
}
