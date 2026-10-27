import type { Db } from "../db/client.js";
import { draftHash } from "./hash.js";

export type OutreachStatus =
  | "pending_approval"
  | "approved"
  | "sending"
  | "send_unknown"
  | "sent"
  | "denied"
  | "expired"
  | "superseded"
  | "failed";

export type OutreachRow = {
  id: number;
  search_id: number;
  github_user_id: number;
  github_login: string;
  channel: string;
  contact_value: string | null;
  contact_provenance: string;
  subject: string | null;
  body: string | null;
  draft_hash: string;
  revision: number;
  status: OutreachStatus;
  decided_by: string | null;
  decided_at: Date | null;
  provider_message_id: string | null;
  sent_at: Date | null;
  error: string | null;
  created_at: Date;
};

export type PrepareInput = {
  searchId: number;
  githubUserId: number;
  githubLogin: string;
  channel?: string;
  contactValue: string;
  contactProvenance: string;
  subject: string;
  body: string;
};

export type PrepareResult =
  | { ok: true; outreachId: number; draftHash: string; revision: number; subject: string; body: string }
  | { ok: false; reason: "suppressed" | "already_contacted" };

const LIVE_STATUSES = ["approved", "sending", "send_unknown", "sent"];

export async function prepareOutreach(db: Db, input: PrepareInput): Promise<PrepareResult> {
  const hash = draftHash(input.subject, input.body);
  try {
    return await db.begin(async (tx): Promise<PrepareResult> => {
      await tx`SELECT pg_advisory_xact_lock(${input.githubUserId})`;
      const suppressed = await tx`
        SELECT 1 FROM suppressed_contacts WHERE github_user_id = ${input.githubUserId}
      `;
      if (suppressed.length > 0) return { ok: false, reason: "suppressed" };

      const live = await tx`
        SELECT 1 FROM outreach
        WHERE github_user_id = ${input.githubUserId} AND status IN ${tx(LIVE_STATUSES)}
      `;
      if (live.length > 0) return { ok: false, reason: "already_contacted" };

      await tx`
        UPDATE outreach SET status = 'superseded'
        WHERE github_user_id = ${input.githubUserId}
          AND search_id = ${input.searchId}
          AND status = 'pending_approval'
      `;
      const [{ next }] = (await tx`
        SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM outreach
        WHERE github_user_id = ${input.githubUserId} AND search_id = ${input.searchId}
      `) as unknown as [{ next: number }];

      const [row] = await tx<{ id: number }[]>`
        INSERT INTO outreach (
          search_id, github_user_id, github_login, channel, contact_value,
          contact_provenance, subject, body, draft_hash, revision, status
        ) VALUES (
          ${input.searchId}, ${input.githubUserId}, ${input.githubLogin},
          ${input.channel ?? "email"}, ${input.contactValue}, ${input.contactProvenance},
          ${input.subject}, ${input.body}, ${hash}, ${next}, 'pending_approval'
        )
        RETURNING id
      `;
      return {
        ok: true,
        outreachId: row!.id,
        draftHash: hash,
        revision: next,
        subject: input.subject,
        body: input.body,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "already_contacted" };
    throw err;
  }
}

export type DecisionInput = {
  outreachId: number;
  draftHash: string;
  decidedBy: string;
};

export type BoundDecisionInput = DecisionInput & {
  to: string;
  login: string;
};

export type DecisionResult =
  | { ok: true; row: OutreachRow }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_pending"
        | "draft_changed"
        | "expired"
        | "already_contacted"
        | "suppressed";
    };

function matchesBinding(row: OutreachRow, input: Partial<BoundDecisionInput>): boolean {
  if (input.to !== undefined && (row.contact_value ?? "").toLowerCase() !== input.to.toLowerCase()) return false;
  if (input.login !== undefined && row.github_login.toLowerCase() !== input.login.toLowerCase()) return false;
  return true;
}

async function diagnose(db: Db, input: DecisionInput & Partial<BoundDecisionInput>): Promise<DecisionResult> {
  const [row] = await db<OutreachRow[]>`SELECT * FROM outreach WHERE id = ${input.outreachId}`;
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "pending_approval") return { ok: false, reason: "not_pending" };
  if (row.draft_hash !== input.draftHash) return { ok: false, reason: "draft_changed" };
  if (!matchesBinding(row, input)) return { ok: false, reason: "draft_changed" };
  const suppressed = await db`
    SELECT 1 FROM suppressed_contacts WHERE github_user_id = ${row.github_user_id}
  `;
  if (suppressed.length > 0) return { ok: false, reason: "suppressed" };
  await db`
    UPDATE outreach SET status = 'expired'
    WHERE id = ${input.outreachId} AND status = 'pending_approval'
      AND created_at <= now() - interval '24 hours'
  `;
  return { ok: false, reason: "expired" };
}

export const LOCKED_ERROR = "sending locked to the allowlist; nothing was sent";

async function decideApproval(
  db: Db,
  input: BoundDecisionInput,
  status: "approved" | "failed",
  error: string | null,
): Promise<DecisionResult> {
  try {
    const rows = await db<OutreachRow[]>`
      UPDATE outreach
      SET status = ${status}, decided_by = ${input.decidedBy}, decided_at = now(), error = ${error}
      WHERE id = ${input.outreachId}
        AND status = 'pending_approval'
        AND draft_hash = ${input.draftHash}
        AND lower(contact_value) = lower(${input.to})
        AND lower(github_login) = lower(${input.login})
        AND created_at > now() - interval '24 hours'
        AND NOT EXISTS (
          SELECT 1 FROM suppressed_contacts s WHERE s.github_user_id = outreach.github_user_id
        )
      RETURNING *
    `;
    if (rows[0]) return { ok: true, row: rows[0] };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "already_contacted" };
    throw err;
  }
  return diagnose(db, input);
}

export function recordApproval(db: Db, input: BoundDecisionInput): Promise<DecisionResult> {
  return decideApproval(db, input, "approved", null);
}

export function recordLockedApproval(db: Db, input: BoundDecisionInput): Promise<DecisionResult> {
  return decideApproval(db, input, "failed", LOCKED_ERROR);
}

export async function recordDenial(db: Db, input: DecisionInput): Promise<DecisionResult> {
  const rows = await db<OutreachRow[]>`
    UPDATE outreach
    SET status = 'denied', decided_by = ${input.decidedBy}, decided_at = now()
    WHERE id = ${input.outreachId}
      AND status = 'pending_approval'
      AND draft_hash = ${input.draftHash}
    RETURNING *
  `;
  if (rows[0]) return { ok: true, row: rows[0] };
  return diagnose(db, input);
}

export async function recordSuppression(db: Db, input: BoundDecisionInput): Promise<DecisionResult> {
  return db.begin(async (tx): Promise<DecisionResult> => {
    const [row] = await tx<OutreachRow[]>`SELECT * FROM outreach WHERE id = ${input.outreachId}`;
    if (!row) return { ok: false, reason: "not_found" };
    if (!matchesBinding(row, input)) return { ok: false, reason: "draft_changed" };
    await tx`
      INSERT INTO suppressed_contacts (github_user_id, github_login, reason, added_by)
      VALUES (${row.github_user_id}, ${row.github_login}, 'never_show_clicked', ${input.decidedBy})
      ON CONFLICT (github_user_id) DO NOTHING
    `;
    const denied = await tx<OutreachRow[]>`
      UPDATE outreach
      SET status = 'denied', decided_by = ${input.decidedBy}, decided_at = now()
      WHERE id = ${input.outreachId} AND status = 'pending_approval'
      RETURNING *
    `;
    return { ok: true, row: denied[0] ?? row };
  });
}

export async function claimSend(db: Db, outreachId: number): Promise<OutreachRow | null> {
  const rows = await db<OutreachRow[]>`
    UPDATE outreach SET status = 'sending'
    WHERE id = ${outreachId} AND status = 'approved'
      AND NOT EXISTS (
        SELECT 1 FROM suppressed_contacts s WHERE s.github_user_id = outreach.github_user_id
      )
    RETURNING *
  `;
  return rows[0] ?? null;
}

export type SendOutcome =
  | {
      kind: "http";
      status: number;
      providerMessageId?: string;
      errorType?: string;
      errorMessage?: string;
    }
  | { kind: "timeout"; error?: string }
  | { kind: "rejected"; error: string };

export type FinishStatus = "sent" | "approved" | "failed" | "send_unknown";

const RETRYABLE_TYPES = new Set(["quotas_exceeded", "transient_state", "locked"]);

export function outcomeStatus(outcome: SendOutcome): FinishStatus {
  if (outcome.kind === "rejected") return "failed";
  if (outcome.kind === "timeout") return "send_unknown";
  const { status } = outcome;
  if (status >= 200 && status < 300) return outcome.providerMessageId ? "sent" : "send_unknown";
  if ((outcome.errorType && RETRYABLE_TYPES.has(outcome.errorType)) || status === 408 || status === 429) {
    return "approved";
  }
  if (status >= 400 && status < 500) return "failed";
  return "send_unknown";
}

export async function finishSend(
  db: Db,
  outreachId: number,
  outcome: SendOutcome,
): Promise<OutreachRow | null> {
  const next = outcomeStatus(outcome);
  const providerId = outcome.kind === "http" && next === "sent" ? (outcome.providerMessageId ?? null) : null;
  const error = next === "sent" ? null : errorFor(outcome);
  const rows = await db<OutreachRow[]>`
    UPDATE outreach
    SET status = ${next},
        provider_message_id = ${providerId},
        sent_at = ${next === "sent" ? db`now()` : null},
        error = ${error}
    WHERE id = ${outreachId} AND status = 'sending'
    RETURNING *
  `;
  return rows[0] ?? null;
}

function errorFor(outcome: SendOutcome): string {
  if (outcome.kind === "rejected") return outcome.error;
  if (outcome.kind === "timeout") return outcome.error ?? "provider request timed out";
  const detail = [outcome.errorType, outcome.errorMessage].filter(Boolean).join(": ");
  if (detail) return detail;
  if (outcome.status >= 200 && outcome.status < 300) return "provider returned 2xx without a message id";
  return `provider returned ${outcome.status}`;
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
