import { describe, expect, it, vi } from "vitest";
import { postToThread } from "../src/slack/post.js";

const TOKEN = "xoxb-secret-token-123";
const message = { channel: "C0FAKE", thread_ts: "1700000000.000100", text: "hello", blocks: [{ type: "divider" }] };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("postToThread", () => {
  it("posts to chat.postMessage with unfurls off and the token only in the header", async () => {
    const f = vi.fn(async () => json({ ok: true, ts: "1700000001.000200" }));
    const r = await postToThread(TOKEN, message, f as unknown as typeof fetch);
    expect(r).toEqual({ ts: "1700000001.000200" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ ...message, unfurl_links: false, unfurl_media: false });
    expect(String(init.body)).not.toContain(TOKEN);
  });

  it("throws with only Slack's error code, never the token or body", async () => {
    const f = async () => json({ ok: false, error: "channel_not_found", detail: TOKEN });
    const err = (await postToThread(TOKEN, message, f as unknown as typeof fetch).catch((e) => e)) as Error;
    expect(err.message).toBe("slack chat.postMessage failed: channel_not_found");
    expect(err.message).not.toContain(TOKEN);
  });

  it("handles non-JSON, http errors and odd error strings", async () => {
    const html = async () => new Response("<html>", { status: 502 });
    await expect(postToThread(TOKEN, message, html as unknown as typeof fetch)).rejects.toThrow("http_502");
    const odd = async () => json({ ok: false, error: `bad ${TOKEN}` }, 400);
    const err = (await postToThread(TOKEN, message, odd as unknown as typeof fetch).catch((e) => e)) as Error;
    expect(err.message).toBe("slack chat.postMessage failed: http_400");
    const noTs = async () => json({ ok: true });
    await expect(postToThread(TOKEN, message, noTs as unknown as typeof fetch)).rejects.toThrow("failed");
  });

  it("passes an abort signal and maps a hanging request to a timeout error", async () => {
    const hang = (_u: unknown, init: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(init.signal?.reason));
      });
    const err = (await postToThread(TOKEN, message, hang as unknown as typeof fetch, 20).catch((e) => e)) as Error;
    expect(err.message).toBe("slack chat.postMessage failed: timeout");
  });

  it("sends a signal with every request and maps other network failures without leaking text", async () => {
    const f = vi.fn(async () => json({ ok: true, ts: "1.1" }));
    await postToThread(TOKEN, message, f as unknown as typeof fetch);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);
    const down = async () => {
      throw new TypeError(`fetch failed ${TOKEN}`);
    };
    const err = (await postToThread(TOKEN, message, down as unknown as typeof fetch).catch((e) => e)) as Error;
    expect(err.message).toBe("slack chat.postMessage failed: network_error");
    expect(err.message).not.toContain(TOKEN);
  });
});
