import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildRequestBody, sendEmail, type ScalewayConfig, type SendResult } from "../src/email/scaleway.js";
import { parseMailbox } from "../src/config.js";
import { demoConfigFromEnv } from "../src/outreach/demo.js";
import { claimSend, prepareOutreach, recordApproval, recordLockedApproval } from "../src/outreach/state.js";
import { createTurnStore } from "../src/slack/turn.js";
import type { ToolDeps } from "../src/tools/deps.js";
import { makeSendOutreach } from "../src/tools/sendOutreach.js";
import { fakeClient } from "./fakeGithub.js";
import { draftInput, getRow, makePending, makeSearch, setupSchema, type TestDb } from "./helpers.js";

const KEY = "scw-secret-key-0123456789";

const cfg: ScalewayConfig = {
  secretKey: KEY,
  projectId: "11111111-2222-3333-4444-555555555555",
  from: { email: "scout@example.test", name: "Scout" },
  replyTo: "owner@example.test",
  auditHeader: true,
};

let t: TestDb;
let db: Db;
let searchId: number;
let nextUser = 7000;

beforeAll(async () => {
  t = await setupSchema();
  db = t.db;
  searchId = await makeSearch(db);
});
afterAll(async () => {
  await t.drop();
});

async function approvedRow(over: Parameters<typeof makePending>[2] = {}) {
  nextUser += 1;
  const p = await makePending(db, searchId, {
    githubUserId: nextUser,
    githubLogin: `fake-send-${nextUser}`,
    contactValue: `fake.send.${nextUser}@example.test`,
    ...over,
  });
  const r = await recordApproval(db, { outreachId: p.id, draftHash: p.hash, decidedBy: "U0APPROVER", to: p.to, login: p.login });
  if (!r.ok) throw new Error("fixture approval failed");
  return p;
}

function setup(send: ToolDeps["send"], over: Partial<ToolDeps> = {}) {
  const posts: { text: string }[] = [];
  const deps: ToolDeps = {
    db: () => db,
    github: () => fakeClient({}),
    demo: () => demoConfigFromEnv({ SEND_MODE: "open" }),
    turn: createTurnStore(),
    post: async (m) => {
      posts.push(m);
      return { ts: "1" };
    },
    sendConfig: () => cfg,
    send,
    now: () => new Date("2026-10-27T09:05:00Z"),
    signature: () => undefined,
    ...over,
  };
  const exec = (outreachId: number) =>
    (makeSendOutreach(deps).execute as unknown as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(
      { outreachId },
      { toolCallId: "t1", messages: [] },
    );
  return { deps, posts, exec };
}

const ok = (id = "email-uuid-1", messageId = "<msg-1@tem>"): SendResult => ({
  outcome: { kind: "http", status: 200, providerMessageId: id },
  messageId,
});

describe("sendOutreach tool", () => {
  it("200 with an id -> sent, stores the provider id, posts the thread message, sends the stored text", async () => {
    const p = await approvedRow();
    const send = vi.fn(async () => ok());
    const { exec, posts } = setup(send);
    const r = await exec(p.id);
    expect(r).toMatchObject({ sent: true, status: "sent" });
    const row = await getRow(db, p.id);
    expect(row).toMatchObject({ status: "sent", provider_message_id: "email-uuid-1", error: null });
    expect(row.sent_at).toBeInstanceOf(Date);
    expect(send).toHaveBeenCalledTimes(1);
    const input = (send.mock.calls[0] as unknown as [ScalewayConfig, Record<string, unknown>])[1];
    expect(input).toMatchObject({ outreachId: p.id, to: p.to, subject: row.subject, text: row.body, draftHash: row.draft_hash });
    expect(posts[0]?.text).toBe(
      `Sent 09:05 UTC · message id &lt;msg-1@tem&gt; (accepted by Scaleway, not yet delivered) · outreach #${p.id}`,
    );
  });

  it.each([
    ["200 without an id", { kind: "http", status: 200 }, "send_unknown"],
    ["408", { kind: "http", status: 408 }, "approved"],
    ["429", { kind: "http", status: 429 }, "approved"],
    ["quotas_exceeded", { kind: "http", status: 403, errorType: "quotas_exceeded", errorMessage: "cap" }, "approved"],
    ["400 invalid_arguments", { kind: "http", status: 400, errorType: "invalid_arguments", errorMessage: "bad" }, "failed"],
    ["500", { kind: "http", status: 500 }, "send_unknown"],
    ["timeout", { kind: "timeout", error: "provider request timed out" }, "send_unknown"],
  ] as const)("%s -> %s", async (_name, outcome, expected) => {
    const p = await approvedRow();
    const { exec, posts } = setup(async () => ({ outcome }));
    const r = await exec(p.id);
    expect(r.status).toBe(expected);
    expect((await getRow(db, p.id)).status).toBe(expected);
    expect(posts).toHaveLength(1);
    if (expected === "send_unknown") expect(posts[0]?.text).toMatch(/Do not resend/);
    if (expected === "approved") expect(posts[0]?.text).toMatch(/still approved/);
  });

  it("escapes provider error text in the thread message", async () => {
    const p = await approvedRow();
    const { exec, posts } = setup(async () => ({
      outcome: { kind: "http", status: 400, errorType: "invalid_arguments", errorMessage: "bad <!channel> input" },
    }));
    await exec(p.id);
    expect(posts[0]?.text).not.toContain("<!channel>");
    expect(posts[0]?.text).toContain("&lt;!channel&gt;");
  });

  it("a send that throws leaves send_unknown with no retry", async () => {
    const p = await approvedRow();
    const send = vi.fn(async () => {
      throw new Error(`boom ${KEY}`);
    });
    const { exec } = setup(send);
    const r = await exec(p.id);
    expect(r.status).toBe("send_unknown");
    expect(send).toHaveBeenCalledTimes(1);
    const row = await getRow(db, p.id);
    expect(row.error).not.toContain(KEY);
  });

  it("hash mismatch -> failed and no fetch", async () => {
    const p = await approvedRow();
    await db`UPDATE outreach SET body = body || ' tampered' WHERE id = ${p.id}`;
    const send = vi.fn(async () => ok());
    const { exec } = setup(send);
    const r = await exec(p.id);
    expect(r.status).toBe("failed");
    expect(send).not.toHaveBeenCalled();
    expect((await getRow(db, p.id)).error).toMatch(/hash/);
  });

  it("a row scrubbed by retention fails closed without a send", async () => {
    const p = await approvedRow();
    await db`UPDATE outreach SET contact_value = NULL, subject = NULL, body = NULL WHERE id = ${p.id}`;
    const send = vi.fn(async () => ok());
    const r = await setup(send).exec(p.id);
    expect(r.status).toBe("failed");
    expect(send).not.toHaveBeenCalled();
    expect((await getRow(db, p.id)).error).toMatch(/retention/);
  });

  it("approved row for a recipient not on the allowlist -> failed, no fetch, lock line posted, then a fresh draft works", async () => {
    const p = await approvedRow();
    const send = vi.fn(async () => ok());
    const demo = demoConfigFromEnv({ SEND_ALLOWED_RECIPIENTS: "owner@example.test" });
    const { exec, posts } = setup(send, { demo: () => demo });
    const r = await exec(p.id);
    expect(r).toMatchObject({ sent: false, status: "failed", locked: true });
    expect(send).not.toHaveBeenCalled();
    const row = await getRow(db, p.id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("sending locked to the allowlist; nothing was sent");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toBe(`Approved, but sending is locked to the allowlist, so nothing was sent (outreach #${p.id}).`);
    const again = await prepareOutreach(db, draftInput(searchId, { githubUserId: row.github_user_id, githubLogin: row.github_login }));
    expect(again.ok).toBe(true);
  });

  it("a locked approval closes the row at click time; SEND_MODE=open later cannot send it; a re-draft works", async () => {
    nextUser += 1;
    const p = await makePending(db, searchId, { githubUserId: nextUser, githubLogin: `fake-send-${nextUser}`, contactValue: `fake.send.${nextUser}@example.test` });
    const r = await recordLockedApproval(db, { outreachId: p.id, draftHash: p.hash, decidedBy: "U0APPROVER", to: p.to, login: p.login });
    expect(r.ok).toBe(true);
    const row = await getRow(db, p.id);
    expect(row).toMatchObject({ status: "failed", decided_by: "U0APPROVER", error: "sending locked to the allowlist; nothing was sent" });
    expect(await claimSend(db, p.id)).toBeNull();
    const send = vi.fn(async () => ok());
    const open = demoConfigFromEnv({ SEND_MODE: "open" });
    const res = await setup(send, { demo: () => open }).exec(p.id);
    expect(res).toMatchObject({ sent: false, status: "failed" });
    expect(send).not.toHaveBeenCalled();
    const again = await prepareOutreach(db, draftInput(searchId, { githubUserId: row.github_user_id, githubLogin: row.github_login }));
    expect(again.ok).toBe(true);
  });

  it("recordLockedApproval keeps the approval guards (wrong recipient, stale hash)", async () => {
    nextUser += 1;
    const p = await makePending(db, searchId, { githubUserId: nextUser, githubLogin: `fake-send-${nextUser}`, contactValue: `fake.send.${nextUser}@example.test` });
    const base = { outreachId: p.id, decidedBy: "U0APPROVER", login: p.login };
    expect(await recordLockedApproval(db, { ...base, draftHash: p.hash, to: "other@example.test" })).toEqual({ ok: false, reason: "draft_changed" });
    expect(await recordLockedApproval(db, { ...base, draftHash: "stale", to: p.to })).toEqual({ ok: false, reason: "draft_changed" });
    expect((await getRow(db, p.id)).status).toBe("pending_approval");
  });

  it("allows an allowlisted recipient", async () => {
    const p = await approvedRow({ contactValue: "owner@example.test" });
    const demo = demoConfigFromEnv({ SEND_ALLOWED_RECIPIENTS: "Owner@Example.test" });
    const send = vi.fn(async () => ok());
    const { exec } = setup(send, { demo: () => demo });
    expect((await exec(p.id)).status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("concurrent calls on one row produce exactly one send", async () => {
    const p = await approvedRow();
    const send = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return ok();
    });
    const { exec } = setup(send);
    const results = await Promise.all([exec(p.id), exec(p.id), exec(p.id), exec(p.id)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.sent === true)).toHaveLength(1);
    expect((await getRow(db, p.id)).status).toBe("sent");
  });

  it.each(["pending_approval", "denied", "sent", "sending", "send_unknown", "failed", "superseded"])(
    "refuses a %s row without sending",
    async (status) => {
      nextUser += 1;
      const p = await makePending(db, searchId, { githubUserId: nextUser, githubLogin: `fake-send-${nextUser}` });
      await db`UPDATE outreach SET status = ${status} WHERE id = ${p.id}`;
      const send = vi.fn(async () => ok());
      const { exec } = setup(send);
      const r = await exec(p.id);
      expect(r).toMatchObject({ sent: false, status });
      expect(send).not.toHaveBeenCalled();
      expect((await getRow(db, p.id)).status).toBe(status);
    },
  );

  it("refuses an unknown id", async () => {
    const send = vi.fn(async () => ok());
    const r = await setup(send).exec(999999);
    expect(r).toMatchObject({ sent: false, status: "not_found" });
  });

  it("does not claim the row when email is not configured", async () => {
    const p = await approvedRow();
    const { ConfigError } = await import("../src/config.js");
    const { exec } = setup(vi.fn(), {
      sendConfig: () => {
        throw new ConfigError(["SCW_SECRET_KEY"]);
      },
    });
    const r = await exec(p.id);
    expect(r).toMatchObject({ sent: false, status: "not_configured" });
    expect(String(r.message)).toContain("SCW_SECRET_KEY");
    expect((await getRow(db, p.id)).status).toBe("approved");
  });

  it("a suppressed person cannot be sent even if approved earlier", async () => {
    const p = await approvedRow();
    const [row] = await db<{ github_user_id: number; github_login: string }[]>`SELECT github_user_id, github_login FROM outreach WHERE id = ${p.id}`;
    await db`INSERT INTO suppressed_contacts (github_user_id, github_login, reason, added_by) VALUES (${row!.github_user_id}, ${row!.github_login}, 'manual', 'U0')`;
    const send = vi.fn(async () => ok());
    const r = await setup(send).exec(p.id);
    expect(r).toMatchObject({ sent: false });
    expect(send).not.toHaveBeenCalled();
    expect((await getRow(db, p.id)).status).toBe("approved");
  });

  it("a failed thread post does not change the outcome", async () => {
    const p = await approvedRow();
    const { exec } = setup(async () => ok(), {
      post: async () => {
        throw new Error("slack down");
      },
    });
    expect((await exec(p.id)).status).toBe("sent");
  });
});

const input = { outreachId: 12, draftHash: "abc123", to: "fake@example.test", subject: "Hi", text: "Body text" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("scaleway client", () => {
  it("posts the documented request with the key only in the auth header", async () => {
    const f = vi.fn(async () => json({ emails: [{ id: "e1", message_id: "m1" }] }));
    const r = await sendEmail(cfg, input, { fetch: f as unknown as typeof fetch });
    expect(r).toEqual({ outcome: { kind: "http", status: 200, providerMessageId: "e1" }, messageId: "m1" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-auth-token"]).toBe(KEY);
    expect(String(init.body)).not.toContain(KEY);
    expect(JSON.parse(String(init.body))).toEqual({
      from: { email: "scout@example.test", name: "Scout" },
      to: [{ email: "fake@example.test" }],
      subject: "Hi",
      text: "Body text",
      project_id: cfg.projectId,
      additional_headers: [
        { key: "Reply-To", value: "owner@example.test" },
        { key: "List-Unsubscribe", value: "<mailto:owner@example.test?subject=unsubscribe>" },
        { key: "X-Scout-Outreach", value: "12:abc123" },
      ],
    });
    expect(init.signal).toBeDefined();
  });

  it("omits the audit header when disabled and html is never sent", () => {
    const body = buildRequestBody({ ...cfg, auditHeader: false }, input);
    expect(body.additional_headers).toEqual([
      { key: "Reply-To", value: "owner@example.test" },
      { key: "List-Unsubscribe", value: "<mailto:owner@example.test?subject=unsubscribe>" },
    ]);
    expect(body).not.toHaveProperty("html");
  });

  it("parses error type and message, redacting the key", async () => {
    const f = async () => json({ type: "invalid_arguments", message: `bad additional_headers ${KEY}` }, 400);
    const r = await sendEmail(cfg, input, { fetch: f as unknown as typeof fetch });
    expect(r.outcome).toMatchObject({ kind: "http", status: 400, errorType: "invalid_arguments" });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("handles non-JSON error and success bodies", async () => {
    const html = async () => new Response("<html>bad gateway</html>", { status: 502 });
    expect((await sendEmail(cfg, input, { fetch: html as unknown as typeof fetch })).outcome).toEqual({
      kind: "http",
      status: 502,
      errorType: undefined,
      errorMessage: undefined,
    });
    const noId = async () => json({ emails: [] });
    expect((await sendEmail(cfg, input, { fetch: noId as unknown as typeof fetch })).outcome).toEqual({
      kind: "http",
      status: 200,
    });
  });

  it("maps timeouts and network errors to the timeout outcome without leaking messages", async () => {
    const timeout = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const net = async () => {
      throw new TypeError(`fetch failed for header ${KEY}`);
    };
    const a = await sendEmail(cfg, input, { fetch: timeout as unknown as typeof fetch });
    const b = await sendEmail(cfg, input, { fetch: net as unknown as typeof fetch });
    expect(a.outcome).toEqual({ kind: "timeout", error: "provider request timed out" });
    expect(b.outcome).toEqual({ kind: "timeout", error: "connection error" });
    expect(JSON.stringify([a, b])).not.toContain(KEY);
  });

  it("really times out a hanging request", async () => {
    const hang = (_u: unknown, init: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(init.signal?.reason));
      });
    const r = await sendEmail(cfg, input, { fetch: hang as unknown as typeof fetch, timeoutMs: 20 });
    expect(r.outcome.kind).toBe("timeout");
  });
});

describe("parseMailbox", () => {
  it("parses named and bare addresses and rejects junk", () => {
    expect(parseMailbox("Scout <scout@example.test>")).toEqual({ email: "scout@example.test", name: "Scout" });
    expect(parseMailbox('"Scout Team" <scout@example.test>')).toEqual({ email: "scout@example.test", name: "Scout Team" });
    expect(parseMailbox("scout@example.test")).toEqual({ email: "scout@example.test" });
    expect(() => parseMailbox("not an address")).toThrow();
  });
});
