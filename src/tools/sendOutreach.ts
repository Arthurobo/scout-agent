import { tool } from "ai";
import { z } from "zod";
import { ConfigError } from "../config.js";
import { draftHash } from "../outreach/hash.js";
import { isRecipientAllowed } from "../outreach/demo.js";
import { LOCKED_ERROR, claimSend, finishSend, type OutreachRow, type SendOutcome } from "../outreach/state.js";
import { escapeMrkdwn } from "../slack/approval.js";
import { stripDashes } from "../text.js";
import type { ToolDeps } from "./deps.js";

const RECONCILE =
  "Reconcile in the Scaleway console, or ListEmails with the project, recipient and subject within 10 minutes of the attempt, then set the row to sent or failed. Do not resend.";

function hhmm(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function threadMessage(row: OutreachRow, messageId: string | undefined, at: Date): string {
  const id = row.id;
  if (row.status === "sent") {
    return `Sent ${hhmm(at)} · message id ${escapeMrkdwn(messageId ?? row.provider_message_id ?? "")} (accepted by Scaleway, not yet delivered) · outreach #${id}`;
  }
  if (row.status === "approved") {
    return `Scaleway did not accept the send (${escapeMrkdwn(row.error ?? "")}). Nothing was sent and outreach #${id} is still approved; it can be sent again without a new approval.`;
  }
  if (row.status === "failed") {
    return `Send failed for outreach #${id}: ${escapeMrkdwn(row.error ?? "")}. Nothing was sent.`;
  }
  return `Send status unknown for outreach #${id} (${escapeMrkdwn(row.error ?? "")}). The email may have been sent. ${RECONCILE}`;
}

export function makeSendOutreach(deps: ToolDeps) {
  return tool({
    title: "Send approved outreach",
    description:
      "Send the stored, human-approved outreach row by id. Only the id is accepted; the stored subject, body and recipient are what get sent. Refuses unless a person approved this exact row in Slack.",
    inputSchema: z.object({ outreachId: z.number().int().positive() }),
    execute: async ({ outreachId }) => {
      let cfg;
      let demo;
      try {
        cfg = deps.sendConfig();
        demo = deps.demo();
      } catch (err) {
        if (err instanceof ConfigError) return { sent: false, status: "not_configured", message: err.message };
        throw err;
      }
      const db = deps.db();

      const claimed = await claimSend(db, outreachId);
      if (!claimed) {
        const [row] = await db<{ status: string }[]>`SELECT status FROM outreach WHERE id = ${outreachId}`;
        return {
          sent: false,
          status: row?.status ?? "not_found",
          message: "Refused: this outreach is not in the approved state (not approved, already sending, or already handled).",
        };
      }

      let outcome: SendOutcome;
      let messageId: string | undefined;
      let locked = false;
      if (claimed.subject === null || claimed.body === null || claimed.contact_value === null) {
        outcome = { kind: "rejected", error: "outreach text was removed by retention" };
      } else if (draftHash(claimed.subject, claimed.body) !== claimed.draft_hash) {
        outcome = { kind: "rejected", error: "stored draft does not match its hash" };
      } else if (claimed.channel !== "email") {
        outcome = { kind: "rejected", error: "only the email channel can be sent" };
      } else if (!isRecipientAllowed(demo, claimed.contact_value)) {
        locked = true;
        outcome = { kind: "rejected", error: LOCKED_ERROR };
      } else {
        try {
          const result = await deps.send(cfg, {
            outreachId: claimed.id,
            draftHash: claimed.draft_hash,
            to: claimed.contact_value,
            subject: claimed.subject,
            text: claimed.body,
          });
          outcome = result.outcome;
          messageId = result.messageId;
        } catch {
          outcome = { kind: "timeout", error: "unexpected error while sending" };
        }
      }

      const finished = await finishSend(db, claimed.id, outcome);
      if (!finished) {
        return { sent: false, status: "unknown", message: `Outreach #${claimed.id} changed state during the send. ${RECONCILE}` };
      }
      const message = stripDashes(
        locked
          ? `Approved, but sending is locked to the allowlist, so nothing was sent (outreach #${finished.id}).`
          : threadMessage(finished, messageId, deps.now()),
      );
      try {
        await deps.post({ text: message });
      } catch {
        console.warn("sendOutreach: thread post failed");
      }
      return { sent: finished.status === "sent", status: finished.status, ...(locked ? { locked: true } : {}), message };
    },
  });
}
