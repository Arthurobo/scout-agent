import { slackButton } from "@trigger.dev/slack";
import type { Candidate } from "../github/sourcing.js";
import { display, escapeMrkdwn, isSafeEvidenceUrl } from "./approval.js";

function section(text: string) {
  return { type: "section", text: { type: "mrkdwn", text } };
}

const ROUTE_NAMES: Record<string, string> = { email: "email", twitter: "X/Twitter", web: "website" };

export function splitRepos(login: string, repos: string[]): { maintains: string[]; contributes: string[] } {
  const own = login.toLowerCase();
  const maintains = repos.filter((r) => r.split("/")[0]?.toLowerCase() === own);
  return { maintains, contributes: repos.filter((r) => !maintains.includes(r)) };
}

export function withheldLine(n: number): string {
  if (n <= 0) return "Demo mode: only consenting people appear.";
  const who = n === 1 ? "1 other real candidate was" : `${n} other real candidates were`;
  return `Demo mode: ${who} found and withheld because they did not consent to appear here.`;
}

export function renderCandidateCard(
  c: Candidate,
  opts: { demoMode?: boolean; withheld?: number } = {},
): { text: string; blocks: unknown[] } {
  const title = c.name
    ? `${display(c.name)} (<${c.profileUrl}|${escapeMrkdwn(c.login)}>)`
    : `<${c.profileUrl}|${escapeMrkdwn(c.login)}>`;
  const lines = [`*${title}*`];
  const about = [c.bio, c.company, c.location].filter((v): v is string => !!v);
  if (about.length > 0) lines.push(display(about.join(" | ").slice(0, 400)));
  const { maintains, contributes } = splitRepos(c.login, c.contributedTo);
  if (maintains.length > 0) lines.push(`Maintains: ${display(maintains.join(", "))}`);
  if (contributes.length > 0) lines.push(`Contributes to: ${display(contributes.join(", "))}`);
  const channels = [...new Set(c.contactRoutes.map((r) => ROUTE_NAMES[r.channel] ?? r.channel))];
  lines.push(
    channels.length > 0
      ? `Published contact routes (GitHub profile): ${channels.join(", ")}`
      : "No contact route published on GitHub profile",
  );

  const blocks: unknown[] = [section(lines.join("\n"))];
  const safe = c.evidence.filter((e) => isSafeEvidenceUrl(e.url));
  safe.forEach((e, i) => {
    const link = `• <${escapeMrkdwn(e.url)}|${display(e.label).replace(/\|/g, "/")}>`;
    blocks.push(section(i === 0 ? `*Evidence*\n${link}` : link));
  });
  if (opts.demoMode) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: withheldLine(opts.withheld ?? 0) }],
    });
  }
  blocks.push({
    type: "actions",
    elements: [
      slackButton({
        text: "Never show this person",
        style: "danger",
        confirm: {
          title: "Never show this person?",
          text: `${c.login} will be added to the do-not-contact list and never suggested again.`,
          confirm: "Add to list",
          deny: "Cancel",
        },
        action: { type: "never_show", githubUserId: c.githubUserId, login: c.login },
      }),
    ],
  });
  return { text: `Candidate: ${escapeMrkdwn(c.login)}`, blocks };
}
