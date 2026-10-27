export class NoThreadError extends Error {
  constructor() {
    super("No Slack thread to post into.");
    this.name = "NoThreadError";
  }
}

export type ThreadPost = {
  channel: string;
  thread_ts: string;
  text: string;
  blocks?: unknown[];
};

export async function postToThread(
  token: string,
  message: ThreadPost,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ ts: string }> {
  let res: Response | undefined;
  let failure = "network_error";
  try {
    res = await fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ...message, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") failure = "timeout";
  }
  if (!res) throw new Error(`slack chat.postMessage failed: ${failure}`);
  let body: { ok?: boolean; ts?: string; error?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new Error(`slack chat.postMessage failed: http_${res.status}`);
  }
  if (!res.ok || !body.ok || !body.ts) {
    const code = body.error && /^[a-z_]{1,64}$/.test(body.error) ? body.error : `http_${res.status}`;
    throw new Error(`slack chat.postMessage failed: ${code}`);
  }
  return { ts: body.ts };
}
