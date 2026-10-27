import { tool } from "ai";
import { z } from "zod";
import { insertSearch } from "../db/queries.js";
import { isRecipientAllowed } from "../outreach/demo.js";
import { prepareOutreach } from "../outreach/state.js";
import { withOptOut, withSignature } from "../outreach/template.js";
import { stripDashes } from "../text.js";
import type { ToolDeps } from "./deps.js";

export const prepareInput = z.object({
  login: z.string().min(1).max(39),
  contactValue: z.string().min(3).max(254),
  subject: z
    .string()
    .min(3)
    .max(200)
    .refine((s) => !/[\r\n]/.test(s), "subject must be a single line")
    .refine((s) => !s.includes("```"), "must not contain a code fence")
    .refine((s) => !/https?:\/\/|www\./i.test(s), "must not contain a URL"),
  body: z
    .string()
    .min(20)
    .max(3000)
    .refine((s) => !s.includes("```"), "must not contain a code fence"),
});

export function makePrepareOutreach(deps: ToolDeps) {
  return tool({
    title: "Prepare outreach draft",
    description:
      "Store an outreach draft for a candidate found by searchGitHub. contactValue must be one of that candidate's email contact routes. Sending may be locked by the allowlist; the approval card says so. Returns outreachId, login, contact, subject and body (an opt-out line is added to the body): pass them to requestOutreachApproval exactly as returned.",
    inputSchema: prepareInput,
    execute: async (input) => {
      const candidate = deps.turn.candidate(input.login);
      if (!candidate) return { refused: true, reason: "Unknown candidate: run searchGitHub first." };
      const route = candidate.contactRoutes.find(
        (r) => r.channel === "email" && r.value.toLowerCase() === input.contactValue.trim().toLowerCase(),
      );
      if (!route) {
        return { refused: true, reason: "contactValue is not an email route published on this candidate's profile." };
      }
      const state = deps.turn.get();
      const db = deps.db();
      const subject = stripDashes(input.subject).replace(/\s+/g, " ").trim();
      const signature = deps.signature();
      const body = withOptOut(withSignature(stripDashes(input.body), signature ? stripDashes(signature) : undefined));
      let searchId = state.searchId;
      if (searchId === undefined) {
        if (!state.thread) return { refused: true, reason: "No Slack thread context. Ask the team to mention Scout again." };
        searchId = await insertSearch(db, {
          slackChannelId: state.thread.channel,
          slackThreadTs: state.thread.threadTs,
          requestedBy: state.thread.userId ?? "unknown",
          query: state.lastQuery ?? "outreach draft",
          triggerRunId: state.runId,
        });
      }
      const result = await prepareOutreach(db, {
        searchId,
        githubUserId: candidate.githubUserId,
        githubLogin: candidate.login,
        contactValue: route.value,
        contactProvenance: route.provenance,
        subject,
        body,
      });
      if (!result.ok) {
        return {
          refused: true,
          reason:
            result.reason === "suppressed"
              ? "This person is on the do-not-contact list."
              : "This person was already approved or contacted.",
        };
      }
      return {
        outreachId: result.outreachId,
        draftHash: result.draftHash,
        revision: result.revision,
        login: candidate.login,
        contact: { value: route.value, provenance: route.provenance },
        sendLocked: !isRecipientAllowed(deps.demo(), route.value),
        subject: result.subject,
        body: result.body,
      };
    },
  });
}
