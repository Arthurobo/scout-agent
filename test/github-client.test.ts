import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createGitHubClient, GitHubError, GitHubRateLimitError } from "../src/github/client.js";

const schema = z.object({ ok: z.boolean() });
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

function setup(responses: Response[], over: Parameters<typeof createGitHubClient>[0] = {}) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next;
  });
  const client = createGitHubClient({
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
    ...over,
  });
  return { client, fetchMock, sleeps };
}

describe("github client", () => {
  it("sends the user agent and api version, and the token only when given", async () => {
    const a = setup([json({ ok: true })], { token: "tok-123" });
    await a.client.getJson("/users/x", {}, schema);
    const init = a.fetchMock.mock.calls[0] as unknown as [URL, { headers: Record<string, string> }];
    expect(init[1].headers["user-agent"]).toBe("scout-agent");
    expect(init[1].headers["x-github-api-version"]).toBe("2022-11-28");
    expect(init[1].headers.authorization).toBe("Bearer tok-123");

    const b = setup([json({ ok: true })]);
    await b.client.getJson("/users/x", {}, schema);
    const initB = b.fetchMock.mock.calls[0] as unknown as [URL, { headers: Record<string, string> }];
    expect(initB[1].headers.authorization).toBeUndefined();
  });

  it("backs off once on a rate limit with retry-after, then succeeds", async () => {
    const { client, sleeps, fetchMock } = setup([
      new Response("{}", { status: 403, headers: { "retry-after": "7" } }),
      json({ ok: true }),
    ]);
    await expect(client.getJson("/users/x", {}, schema)).resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([7000]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("backs off until the reset time when remaining is 0", async () => {
    const reset = String(1_000 + 5);
    const { client, sleeps } = setup([
      new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } }),
      json({ ok: true }),
    ]);
    await client.getJson("/users/x", {}, schema);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBe(6000);
  });

  it("fails with a clear error when the limit hits again after one retry", async () => {
    const limited = () => new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    const { client, fetchMock } = setup([limited(), limited()]);
    await expect(client.getJson("/users/x", {}, schema)).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails immediately when the wait exceeds the cap", async () => {
    const reset = String(Math.floor(1_000_000 / 1000) + 3600);
    const { client, sleeps, fetchMock } = setup([
      new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } }),
    ]);
    await expect(client.getJson("/users/x", {}, schema)).rejects.toThrow(/rate limit/i);
    expect(sleeps).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a plain 403 without limit headers as a normal error", async () => {
    const { client } = setup([new Response("{}", { status: 403 })]);
    const err = await client.getJson("/users/x", {}, schema).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).not.toBeInstanceOf(GitHubRateLimitError);
  });

  it("does not leak the token in errors", async () => {
    const { client } = setup([new Response("{}", { status: 500 })], { token: "tok-secret-999" });
    const err = (await client.getJson("/users/x", {}, schema).catch((e) => e)) as Error;
    expect(String(err.message)).not.toContain("tok-secret-999");
  });

  it("rejects an unexpected response shape", async () => {
    const { client } = setup([json({ nope: 1 })]);
    await expect(client.getJson("/users/x", {}, schema)).rejects.toThrow(/unexpected shape/);
  });

  it("throttles search calls to 30 per minute and does not throttle core calls", async () => {
    const responses = Array.from({ length: 70 }, () => json({ ok: true }));
    const { client, sleeps } = setup(responses);
    for (let i = 0; i < 31; i++) await client.getJson("/search/issues", {}, schema);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(50_000);
    for (let i = 0; i < 30; i++) await client.getJson("/users/x", {}, schema);
    expect(sleeps).toHaveLength(1);
  });
});
