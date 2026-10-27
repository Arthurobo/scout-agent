import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { expireStalePending, runRetention, scrubOldOutreach } from "../src/db/retention.js";
import { recordApproval, recordSuppression } from "../src/outreach/state.js";
import { getRow, makePending, makeSearch, setupSchema, type TestDb } from "./helpers.js";

let t: TestDb;
let db: Db;
let searchId: number;
let nextUser = 9000;

beforeAll(async () => {
  t = await setupSchema();
  db = t.db;
  searchId = await makeSearch(db);
});
afterAll(async () => {
  await t.drop();
});

async function row(status: string, ageHours: number) {
  nextUser += 1;
  const p = await makePending(db, searchId, {
    githubUserId: nextUser,
    githubLogin: `fake-ret-${nextUser}`,
    contactValue: `fake.ret.${nextUser}@example.test`,
  });
  await db`
    UPDATE outreach SET status = ${status}, created_at = now() - make_interval(hours => ${ageHours}),
      provider_message_id = ${status === "sent" ? "msg-keep" : null}, decided_by = 'U0APPROVER'
    WHERE id = ${p.id}
  `;
  return p;
}

describe("expireStalePending", () => {
  it("expires only pending rows older than 24h", async () => {
    const old = await row("pending_approval", 25);
    const fresh = await row("pending_approval", 23);
    const approvedOld = await row("approved", 48);
    const before = await expireStalePending(db);
    expect(before).toBeGreaterThanOrEqual(1);
    expect((await getRow(db, old.id)).status).toBe("expired");
    expect((await getRow(db, fresh.id)).status).toBe("pending_approval");
    expect((await getRow(db, approvedOld.id)).status).toBe("approved");
    expect(await expireStalePending(db)).toBe(0);
  });

  it("an expired row can no longer be approved", async () => {
    const p = await row("pending_approval", 30);
    await expireStalePending(db);
    const r = await recordApproval(db, { outreachId: p.id, draftHash: p.hash, decidedBy: "U0APPROVER", to: p.to, login: p.login });
    expect(r).toEqual({ ok: false, reason: "not_pending" });
  });
});

describe("scrubOldOutreach", () => {
  it("clears contact, subject and body of rows older than 90 days and keeps everything else", async () => {
    const old = await row("sent", 91 * 24);
    const young = await row("sent", 89 * 24);
    const before = await getRow(db, old.id);
    const n = await scrubOldOutreach(db);
    expect(n).toBeGreaterThanOrEqual(1);
    const after = await getRow(db, old.id);
    expect(after.contact_value).toBeNull();
    expect(after.subject).toBeNull();
    expect(after.body).toBeNull();
    expect(after).toMatchObject({
      id: before.id,
      search_id: before.search_id,
      github_user_id: before.github_user_id,
      github_login: before.github_login,
      status: "sent",
      draft_hash: before.draft_hash,
      decided_by: "U0APPROVER",
      provider_message_id: "msg-keep",
      contact_provenance: before.contact_provenance,
      revision: before.revision,
    });
    expect(after.created_at).toEqual(before.created_at);
    const youngAfter = await getRow(db, young.id);
    expect(youngAfter.body).not.toBeNull();
    expect(youngAfter.contact_value).not.toBeNull();
  });

  it("also clears provider error text that may quote the recipient", async () => {
    const old = await row("failed", 91 * 24);
    await db`UPDATE outreach SET error = ${"invalid_arguments: recipient " + old.to + " is invalid"} WHERE id = ${old.id}`;
    const young = await row("failed", 5 * 24);
    await db`UPDATE outreach SET error = 'invalid_arguments: keep me' WHERE id = ${young.id}`;
    await scrubOldOutreach(db);
    expect((await getRow(db, old.id)).error).toBeNull();
    expect((await getRow(db, young.id)).error).toBe("invalid_arguments: keep me");
  });

  it("scrubs an old row whose only remaining data is the error text", async () => {
    const old = await row("failed", 95 * 24);
    await scrubOldOutreach(db);
    await db`UPDATE outreach SET error = 'late error' WHERE id = ${old.id}`;
    expect(await scrubOldOutreach(db)).toBeGreaterThanOrEqual(1);
    expect((await getRow(db, old.id)).error).toBeNull();
  });

  it("is idempotent", async () => {
    await row("denied", 100 * 24);
    expect(await scrubOldOutreach(db)).toBeGreaterThanOrEqual(1);
    expect(await scrubOldOutreach(db)).toBe(0);
  });

  it("keeps the never-twice index working for a scrubbed sent row", async () => {
    const old = await row("sent", 120 * 24);
    await scrubOldOutreach(db);
    const [owner] = await db<{ github_user_id: number }[]>`SELECT github_user_id FROM outreach WHERE id = ${old.id}`;
    const github_user_id = owner!.github_user_id;
    const [other] = await db<{ id: number }[]>`
      INSERT INTO outreach (search_id, github_user_id, github_login, contact_value, contact_provenance, subject, body, draft_hash, status)
      VALUES (${searchId}, ${github_user_id}, 'dup', 'dup@example.test', 'p', 's', 'b', 'h', 'pending_approval')
      RETURNING id
    `;
    await expect(db`UPDATE outreach SET status = 'approved' WHERE id = ${other!.id}`).rejects.toMatchObject({ code: "23505" });
  });

  it("never touches suppressed_contacts", async () => {
    nextUser += 1;
    await db`INSERT INTO suppressed_contacts (github_user_id, github_login, reason, added_by, created_at)
      VALUES (${nextUser}, 'fake-old-suppressed', 'manual', 'U0', now() - interval '400 days')`;
    await runRetention(db);
    const rows = await db`SELECT github_login FROM suppressed_contacts WHERE github_user_id = ${nextUser}`;
    expect(rows).toHaveLength(1);
  });

  it("suppression still works on a scrubbed row without throwing", async () => {
    const old = await row("expired", 200 * 24);
    await scrubOldOutreach(db);
    const r = await recordSuppression(db, { outreachId: old.id, draftHash: old.hash, decidedBy: "U0APPROVER", to: old.to, login: old.login });
    expect(r).toEqual({ ok: false, reason: "draft_changed" });
  });
});

describe("runRetention", () => {
  it("returns counts only and runs expiry before scrubbing", async () => {
    await row("pending_approval", 26);
    await row("sent", 95 * 24);
    const counts = await runRetention(db);
    expect(Object.keys(counts).sort()).toEqual(["expired", "scrubbed"]);
    expect(counts.expired).toBeGreaterThanOrEqual(1);
    expect(counts.scrubbed).toBeGreaterThanOrEqual(1);
    expect(await runRetention(db)).toEqual({ expired: 0, scrubbed: 0 });
  });

  it("a pending row older than 90 days is expired and scrubbed in one run", async () => {
    const p = await row("pending_approval", 100 * 24);
    await runRetention(db);
    const after = await getRow(db, p.id);
    expect(after.status).toBe("expired");
    expect(after.body).toBeNull();
  });
});
