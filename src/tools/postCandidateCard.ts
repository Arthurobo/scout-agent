import { tool } from "ai";
import { z } from "zod";
import { renderCandidateCard } from "../slack/candidateCard.js";
import { NoThreadError } from "../slack/post.js";
import type { ToolDeps } from "./deps.js";

export function nextStep(posted: string[]): string {
  if (posted.length === 0) return "";
  if (posted.length === 1) return `Say "draft outreach to ${posted[0]}" and I will prepare an email for approval.`;
  const [first, ...rest] = posted;
  return `Say "draft outreach to ${first}" (or ${rest.join(", ")}) and I will prepare an email for approval.`;
}

export function summaryLine(posted: string[]): string {
  if (posted.length === 0) return "";
  if (posted.length === 1) return `Posted 1 candidate card: ${posted[0]}.`;
  return `Posted ${posted.length} candidate cards: ${posted.join(", ")}.`;
}

export function makePostCandidateCard(deps: ToolDeps) {
  return tool({
    title: "Post candidate cards",
    description:
      "Post a Slack card for each candidate returned by searchGitHub, by login. The card content is rendered from the stored search result, not from your text. Each card has a Never show this person button. The result has summary and nextStep lines for your reply.",
    inputSchema: z.object({ logins: z.array(z.string().min(1).max(39)).min(1).max(3) }),
    execute: async ({ logins }) => {
      const demoMode = deps.demo().enabled;
      const posted: string[] = [];
      const unknown: string[] = [];
      const alreadyPosted: string[] = [];
      for (const login of logins) {
        const candidate = deps.turn.candidate(login);
        if (!candidate) {
          unknown.push(login);
          continue;
        }
        if (!deps.turn.markPosted(candidate.login)) {
          alreadyPosted.push(candidate.login);
          continue;
        }
        try {
          await deps.post(renderCandidateCard(candidate, { demoMode, withheld: deps.turn.get().withheld }));
        } catch (err) {
          deps.turn.unmarkPosted(candidate.login);
          if (err instanceof NoThreadError) return { error: err.message };
          throw err;
        }
        posted.push(candidate.login);
      }
      return { posted, alreadyPosted, unknown, nextStep: nextStep(posted), summary: summaryLine(posted) };
    },
  });
}
