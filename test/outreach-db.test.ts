import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { draftHash } from "../src/outreach/hash.js";
import {
  claimSend,
  finishSend,
  prepareOutreach,
  recordApproval,
  recordDenial,
  recordSuppression,
} from "../src/outreach/state.js";
import { draftInput, getRow, makePending, makeSearch, setupSchema, type TestDb } from "./helpers.js";

let t: TestDb;
let db: Db;
let searchId: number;
let nextUser = 5000;

beforeAll(async () => {
  t = await setupSchema();
  db = t.db;
  searchId = await makeSearch(db);
});

afterAll(async () => {
  await t.drop();
});

function freshUser() {
  nextUser += 1;
  return { githubUserId: nextUser, githubLogin: `fake-dev-${nextUser}` };
}

async function forceStatus(id: number, status: string) {
  await db`UPDATE outreach SET status = ${status} WHERE id = ${id}`;
}

describe("unique index on live outreach", () => {
  it.each(["approved", "sending", "send_unknown", "sent"])(
    "rejects a second %s row for the same github_user_id",
    async (status) => {
      const u = freshUser();
      const a = await makePending(db, searchId, u);
      await forceStatus(a.id, status);
      const [b] = await db<{ id: number }[]>`
        INSERT INTO outreach (search_id, github_user_id, github_login, contact_value,
          contact_provenance, subject, body, draft_hash, status)
        VALUES (${searchId}, ${u.githubUserId}, ${u.githubLogin}, 'x@example.test', 'p',
          's', 'b', 'h', 'pending_approval')
        RETURNING id
      `;
      await expect(forceStatus(b!.id, "approved")).rejects.toMatchObject({ code: "23505" });
    },
  );

  it("frees the slot when the live row becomes failed", async () => {
    const u = freshUser();
    const a = await makePending(db, searchId, u);
    await forceStatus(a.id, "approved");
    const b = await makePending(db, searchId, { ...u, contactValue: "other@example.test" }).catch(
      (e: Error) => e,
    );
    expect(b).toBeInstanceOf(Error);

    await forceStatus(a.id, "failed");
    const c = await makePending(db, searchId, u);
    await forceStatus(c.id, "approved");
    expect((await getRow(db, c.id)).status).toBe("approved");
  });

  it("allows several non-live rows for the same user", async () => {
    const u = freshUser();
    const a = await makePending(db, searchId, u);
    await forceStatus(a.id, "denied");
    const b = await makePending(db, searchId, u);
    await forceStatus(b.id, "expired");
    const c = await makePending(db, searchId, u);
    expect(c.id).toBeGreaterThan(b.id);
  });
});

describe("approval UPDATE guards", () => {
  it("approves a pending row with the matching hash", async () => {
    const p = await makePending(db, searchId, freshUser());
    const r = await recordApproval(db, { outreachId: p.id, draftHash: p.hash, decidedBy: "U0APPROVER", to: p.to, login: p.login });
    expect(r.ok).toBe(true);
    const row = await getRow(db, p.id);
    expect(row.status).toBe("approved");
    expect(row.decided_by).toBe("U0APPROVER");
    expect(row.decided_at).toBeInstanceOf(Date);
  });

  it("matches zero rows on draft_hash mismatch", async () => {
    const p = await makePending(db, searchId, freshUser());
    const r = await recordApproval(db, {
      outreachId: p.id,
      draftHash: draftHash("other subject", "other body"),
      decidedBy: "U0APPROVER", to: p.to, login: p.login,
    });
    expect(r).toEqual({ ok: false, reason: "draft_changed" });
    expect((await getRow(db, p.id)).status).toBe("pending_approval");
  });

  it("matches zero rows on a superseded revision", async () => {
    const u = freshUser();
    const first = await makePending(db, searchId, u);
    const second = await prepareOutreach(db, draftInput(searchId, { ...u, subject: "Revised subject" }));
    expect(second.ok && second.revision).toBe(2);
    const r = await recordApproval(db, { outreachId: first.id, draftHash: first.hash, decidedBy: "U0APPROVER", to: first.to, login: first.login });
    expect(r).toEqual({ ok: false, reason: "not_pending" });
    const row = await getRow(db, first.id);
    expect(row.status).toBe("superseded");
  });

  it.each(["approved", "denied", "sent", "failed"])("matches zero rows when status is %s", async (status) => {
    const p = await makePending(db, searchId, freshUser());
    await forceStatus(p.id, status);
    const r = await recordApproval(db, { outreachId: p.id, draftHash: p.hash, decidedBy: "U0APPROVER", to: p.to, login: p.login });
    expect(r).toEqual({ ok: false, reason: "not_pending" });
    expect((await getRow(db, p.id)).status).toBe(status);
  });

  it("matches zero rows when older than 24h and marks the row expired", async () => {
    const p = await makePending(db, searchId, freshUser());
    await db`UPDATE outreach SET created_at = now() - interval '25 hours' WHERE id = ${p.id}`;
    const r = await recordApproval(db, { outreachId: p.id, draftHash: p.hash, decidedBy: "U0APPROVER", to: p.to, login: p.login });
    expect(r).toEqual({ ok: false, reason: "expired" });
    expect((await getRow(db, p.id)).status).toBe("expired");
  });

  it("reports not_found for an unknown id", async () => {
    const r = await recordApproval(db, {
      outreachId: 999999,
      draftHash: "x",
      decidedBy: "U0APPROVER",
      to: "x@example.test",
      login: "x",
    });
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses with already_contacted when another row for the user is live", async () => {
    const u = freshUser();
    const a = await makePending(db, searchId, u);
    const otherSearch = await makeSearch(db);
    const b = await makePending(db, otherSearch, u);
    const first = await recordApproval(db, { outreachId: a.id, draftHash: a.hash, decidedBy: "U0APPROVER", to: a.to, login: a.login });
    expect(first.ok).toBe(true);
    const second = await recordApproval(db, { outreachId: b.id, draftHash: b.hash, decidedBy: "U0APPROVER", to: b.to, login: b.login });
    expect(second).toEqual({ ok: false, reason: "already_contacted" });
    expect((await getRow(db, b.id)).status).toBe("pending_approval");
  });
});

describe("approval and suppression are bound to the stored contact and login", () => {
  it("recordApproval refuses a different recipient or login even with a matching hash", async () => {
    for (const bad of [{ to: "attacker@example.test" }, { login: "someone-else" }]) {
      const p = await makePending(db, searchId, freshUser());
      const r = await recordApproval(db, {
        outreachId: p.id,
        draftHash: p.hash,
        decidedBy: "U0APPROVER",
        to: p.to,
        login: p.login,
        ...bad,
      });
      expect(r).toEqual({ ok: false, reason: "draft_changed" });
      const row = await getRow(db, p.id);
      expect(row.status).toBe("pending_approval");
      expect(row.decided_by).toBeNull();
    }
  });

  it("recordApproval compares recipient and login case-insensitively", async () => {
    const p = await makePending(db, searchId, freshUser());
    const r = await recordApproval(db, {
      outreachId: p.id,
      draftHash: p.hash,
      decidedBy: "U0APPROVER",
      to: p.to.toUpperCase(),
      login: p.login.toUpperCase(),
    });
    expect(r.ok).toBe(true);
  });

  it("recordSuppression refuses a different recipient or login and records nothing", async () => {
    for (const bad of [{ to: "attacker@example.test" }, { login: "someone-else" }]) {
      const u = freshUser();
      const p = await makePending(db, searchId, u);
      const r = await recordSuppression(db, {
        outreachId: p.id,
        draftHash: p.hash,
        decidedBy: "U0APPROVER",
        to: p.to,
        login: p.login,
        ...bad,
      });
      expect(r).toEqual({ ok: false, reason: "draft_changed" });
      expect((await getRow(db, p.id)).status).toBe("pending_approval");
      const rows = await db`SELECT 1 FROM suppressed_contacts WHERE github_user_id = ${u.githubUserId}`;
      expect(rows).toHaveLength(0);
    }
  });
});

describe("send claim", () => {
  async function approved() {
    const p = await makePending(db, searchId, freshUser());
    await recordApproval(db, { outreachId: p.id, draftHash: p.hash, decidedBy: "U0APPROVER", to: p.to, login: p.login });
    return p;
  }

  it("claims an approved row once; a second claim matches zero rows", async () => {
    const p = await approved();
    const first = await claimSend(db, p.id);
    expect(first?.status).toBe("sending");
    const second = await claimSend(db, p.id);
    expect(second).toBeNull();
  });

  it("concurrent claims produce exactly one winner", async () => {
    const p = await approved();
    const results = await Promise.all([claimSend(db, p.id), claimSend(db, p.id), claimSend(db, p.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it.each(["pending_approval", "denied", "sent", "sending", "send_unknown"])(
    "refuses to claim a row that is %s",
    async (status) => {
      const p = await makePending(db, searchId, freshUser());
      await forceStatus(p.id, status);
      expect(await claimSend(db, p.id)).toBeNull();
    },
  );

  it("finishSend maps provider outcomes to statuses", async () => {
    const cases: [Parameters<typeof finishSend>[2], string, string?][] = [
      [{ kind: "http", status: 200, providerMessageId: "msg-1" }, "sent"],
      [{ kind: "http", status: 201, providerMessageId: "msg-1" }, "sent"],
      [{ kind: "http", status: 200 }, "send_unknown", "2xx without a message id"],
      [{ kind: "http", status: 200, providerMessageId: "msg-1", errorType: "transient_state" }, "sent"],
      [{ kind: "http", status: 202, providerMessageId: "msg-1", errorType: "quotas_exceeded" }, "sent"],
      [{ kind: "http", status: 200, errorType: "locked" }, "send_unknown"],
      [{ kind: "http", status: 429 }, "approved"],
      [{ kind: "http", status: 408 }, "approved"],
      [{ kind: "http", status: 400, errorType: "quotas_exceeded", errorMessage: "monthly cap" }, "approved", "quotas_exceeded: monthly cap"],
      [{ kind: "http", status: 403, errorType: "quotas_exceeded" }, "approved", "quotas_exceeded"],
      [{ kind: "http", status: 409, errorType: "transient_state" }, "approved", "transient_state"],
      [{ kind: "http", status: 423, errorType: "locked" }, "approved", "locked"],
      [{ kind: "http", status: 400, errorType: "invalid_arguments", errorMessage: "bad header" }, "failed", "invalid_arguments: bad header"],
      [{ kind: "http", status: 403, errorType: "permissions_denied" }, "failed", "permissions_denied"],
      [{ kind: "http", status: 401, errorType: "denied_authentication" }, "failed", "denied_authentication"],
      [{ kind: "http", status: 404 }, "failed"],
      [{ kind: "http", status: 500 }, "send_unknown"],
      [{ kind: "http", status: 503, errorType: "invalid_arguments" }, "send_unknown"],
      [{ kind: "http", status: 302 }, "send_unknown"],
      [{ kind: "timeout" }, "send_unknown"],
      [{ kind: "rejected", error: "draft hash mismatch" }, "failed", "draft hash mismatch"],
    ];
    for (const [outcome, expected, errorHas] of cases) {
      const p = await approved();
      await claimSend(db, p.id);
      const row = await finishSend(db, p.id, outcome);
      expect(row?.status, JSON.stringify(outcome)).toBe(expected);
      if (expected === "sent") {
        expect(row?.provider_message_id).toBe("msg-1");
        expect(row?.sent_at).toBeInstanceOf(Date);
        expect(row?.error).toBeNull();
      } else {
        expect(row?.sent_at).toBeNull();
        expect(row?.provider_message_id).toBeNull();
        expect(row?.error).toBeTruthy();
        if (errorHas) expect(row?.error).toContain(errorHas);
      }
    }
  });

  it("a 429 returns the row to approved so it can be claimed again", async () => {
    const p = await approved();
    await claimSend(db, p.id);
    await finishSend(db, p.id, { kind: "http", status: 429 });
    expect((await claimSend(db, p.id))?.status).toBe("sending");
  });

  it("finishSend does nothing unless the row is sending", async () => {
    const p = await approved();
    expect(await finishSend(db, p.id, { kind: "http", status: 200, providerMessageId: "m" })).toBeNull();
    expect((await getRow(db, p.id)).status).toBe("approved");
  });
});

describe("prepareOutreach", () => {
  it("supersedes earlier pending rows for the same user and search and bumps the revision", async () => {
    const u = freshUser();
    const a = await prepareOutreach(db, draftInput(searchId, { ...u, subject: "v1" }));
    const b = await prepareOutreach(db, draftInput(searchId, { ...u, subject: "v2" }));
    if (!a.ok || !b.ok) throw new Error("expected both prepared");
    expect(a.revision).toBe(1);
    expect(b.revision).toBe(2);
    expect((await getRow(db, a.outreachId)).status).toBe("superseded");
    expect((await getRow(db, b.outreachId)).status).toBe("pending_approval");
    expect(b.draftHash).toBe(draftHash("v2", draftInput(searchId).body));
  });

  it("does not supersede pending rows from a different search", async () => {
    const u = freshUser();
    const other = await makeSearch(db);
    const a = await prepareOutreach(db, draftInput(searchId, u));
    await prepareOutreach(db, draftInput(other, u));
    if (!a.ok) throw new Error("expected prepared");
    expect((await getRow(db, a.outreachId)).status).toBe("pending_approval");
  });

  it("refuses a suppressed contact", async () => {
    const u = freshUser();
    const p = await makePending(db, searchId, u);
    await recordSuppression(db, { outreachId: p.id, draftHash: p.hash, decidedBy: "U0APPROVER", to: p.to, login: p.login });
    const again = await prepareOutreach(db, draftInput(searchId, u));
    expect(again).toEqual({ ok: false, reason: "suppressed" });
  });

  it.each(["approved", "sending", "send_unknown", "sent"])(
    "refuses a contact that is already %s",
    async (status) => {
      const u = freshUser();
      const p = await makePending(db, searchId, u);
      await forceStatus(p.id, status);
      const again = await prepareOutreach(db, draftInput(searchId, u));
      expect(again).toEqual({ ok: false, reason: "already_contacted" });
    },
  );

  it("allows a new draft after the earlier one was denied, failed or expired", async () => {
    for (const status of ["denied", "failed", "expired"]) {
      const u = freshUser();
      const p = await makePending(db, searchId, u);
      await forceStatus(p.id, status);
      const again = await prepareOutreach(db, draftInput(searchId, u));
      expect(again.ok).toBe(true);
    }
  });
});

describe("denial and suppression", () => {
  it("denies a pending row", async () => {
    const p = await makePending(db, searchId, freshUser());
    const r = await recordDenial(db, { outreachId: p.id, draftHash: p.hash, decidedBy: "U0APPROVER" });
    expect(r.ok).toBe(true);
    expect((await getRow(db, p.id)).status).toBe("denied");
  });

  it("denial on a stale hash is a no-op", async () => {
    const p = await makePending(db, searchId, freshUser());
    const r = await recordDenial(db, { outreachId: p.id, draftHash: "stale", decidedBy: "U0APPROVER" });
    expect(r).toEqual({ ok: false, reason: "draft_changed" });
    expect((await getRow(db, p.id)).status).toBe("pending_approval");
  });

  it("suppression denies the row and records the contact", async () => {
    const u = freshUser();
    const p = await makePending(db, searchId, u);
    const r = await recordSuppression(db, { outreachId: p.id, draftHash: p.hash, decidedBy: "U0APPROVER", to: p.to, login: p.login });
    expect(r.ok).toBe(true);
    expect((await getRow(db, p.id)).status).toBe("denied");
    const rows = await db`SELECT reason, added_by FROM suppressed_contacts WHERE github_user_id = ${u.githubUserId}`;
    expect(rows[0]).toMatchObject({ reason: "never_show_clicked", added_by: "U0APPROVER" });
  });

  it("suppression with a mismatched hash still records the contact and denies the pending row", async () => {
    const u = freshUser();
    const p = await makePending(db, searchId, u);
    const r = await recordSuppression(db, { outreachId: p.id, draftHash: "stale", decidedBy: "U0APPROVER", to: p.to, login: p.login });
    expect(r.ok).toBe(true);
    const rows = await db`SELECT 1 FROM suppressed_contacts WHERE github_user_id = ${u.githubUserId}`;
    expect(rows).toHaveLength(1);
    expect((await getRow(db, p.id)).status).toBe("denied");
  });

  it("suppression via a superseded revision records the contact and keeps the status", async () => {
    const u = freshUser();
    const first = await makePending(db, searchId, u);
    const second = await prepareOutreach(db, draftInput(searchId, { ...u, subject: "Revised" }));
    if (!second.ok) throw new Error("expected prepared");
    const r = await recordSuppression(db, { outreachId: first.id, draftHash: first.hash, decidedBy: "U0APPROVER", to: first.to, login: first.login });
    expect(r.ok).toBe(true);
    expect((await getRow(db, first.id)).status).toBe("superseded");
    expect((await getRow(db, second.outreachId)).status).toBe("pending_approval");
    const rows = await db`SELECT 1 FROM suppressed_contacts WHERE github_user_id = ${u.githubUserId}`;
    expect(rows).toHaveLength(1);
  });

  it("suppression on an expired or denied row still records the contact", async () => {
    for (const status of ["expired", "denied"]) {
      const u = freshUser();
      const p = await makePending(db, searchId, u);
      await forceStatus(p.id, status);
      const r = await recordSuppression(db, { outreachId: p.id, draftHash: p.hash, decidedBy: "U0APPROVER", to: p.to, login: p.login });
      expect(r.ok).toBe(true);
      expect((await getRow(db, p.id)).status).toBe(status);
      const rows = await db`SELECT 1 FROM suppressed_contacts WHERE github_user_id = ${u.githubUserId}`;
      expect(rows).toHaveLength(1);
    }
  });

  it("suppression is idempotent and reports not_found for an unknown id", async () => {
    const u = freshUser();
    const p = await makePending(db, searchId, u);
    const input = { outreachId: p.id, draftHash: p.hash, decidedBy: "U0APPROVER", to: p.to, login: p.login };
    expect((await recordSuppression(db, input)).ok).toBe(true);
    expect((await recordSuppression(db, input)).ok).toBe(true);
    expect(await recordSuppression(db, { ...input, outreachId: 999999 })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("suppression blocks pending rows in other searches", () => {
  it("refuses approval of a pending row for a suppressed person", async () => {
    const u = freshUser();
    const otherSearch = await makeSearch(db);
    const a = await makePending(db, searchId, u);
    const b = await makePending(db, otherSearch, u);
    await recordSuppression(db, { outreachId: a.id, draftHash: a.hash, decidedBy: "U0APPROVER", to: a.to, login: a.login });
    const r = await recordApproval(db, { outreachId: b.id, draftHash: b.hash, decidedBy: "U0APPROVER", to: b.to, login: b.login });
    expect(r).toEqual({ ok: false, reason: "suppressed" });
    expect((await getRow(db, b.id)).status).toBe("pending_approval");
  });

  it("refuses to claim an approved row once the person is suppressed", async () => {
    const u = freshUser();
    const otherSearch = await makeSearch(db);
    const a = await makePending(db, searchId, u);
    const b = await makePending(db, otherSearch, u);
    const approved = await recordApproval(db, { outreachId: b.id, draftHash: b.hash, decidedBy: "U0APPROVER", to: b.to, login: b.login });
    expect(approved.ok).toBe(true);
    await recordSuppression(db, { outreachId: a.id, draftHash: a.hash, decidedBy: "U0APPROVER", to: a.to, login: a.login });
    expect(await claimSend(db, b.id)).toBeNull();
    expect((await getRow(db, b.id)).status).toBe("approved");
  });
});
