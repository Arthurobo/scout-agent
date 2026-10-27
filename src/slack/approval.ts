import { z } from "zod";
import { draftHash } from "../outreach/hash.js";
import { stripDashes } from "../text.js";

export function isSafeEvidenceUrl(url: string): boolean {
  if (/[\s<>|]/.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "github.com" || u.hostname.endsWith(".github.com"));
  } catch {
    return false;
  }
}

const noFence = (s: string) => !s.includes("```");
const noUrl = (s: string) => !/https?:\/\/|www\./i.test(s);
const NO_URL = "must not contain a URL";

export const approvalInput = z.object({
  outreachId: z.number().int().positive(),
  candidate: z.object({
    login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
    name: z.string().max(100).refine(noUrl, NO_URL).optional(),
    summary: z.string().max(500).refine(noUrl, NO_URL).optional(),
  }),
  evidence: z
    .array(
      z.object({
        label: z.string().min(1).max(100).refine(noUrl, NO_URL),
        url: z.string().max(500).refine(isSafeEvidenceUrl, "must be a plain https github.com URL"),
      }),
    )
    .max(6),
  contact: z.object({ value: z.string().min(1).max(254), provenance: z.string().min(1).max(200).refine(noUrl, NO_URL) }),
  subject: z
    .string()
    .min(1)
    .max(200)
    .refine(noFence, "must not contain a code fence")
    .refine(noUrl, NO_URL),
  body: z.string().min(1).max(8000).refine(noFence, "must not contain a code fence"),
});

export type ApprovalInput = z.infer<typeof approvalInput>;

export const approvalOutput = z.object({
  approved: z.boolean(),
  authorized: z.boolean().optional(),
  id: z.number().int().positive(),
  h: z.string(),
  to: z.string().min(1),
  login: z.string().min(1),
  decidedBy: z.string().optional(),
  suppress: z.boolean().optional(),
  whatToSay: z.string().optional(),
  locked: z.boolean().optional(),
});

export type ApprovalOutput = z.infer<typeof approvalOutput>;

export type ButtonFactory = (options: {
  text: string;
  style?: "primary" | "danger";
  confirm?: { title: string; text: string; confirm?: string; deny?: string };
  output: unknown;
}) => unknown;

const SECTION_LIMIT = 2800;

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function display(s: string): string {
  return escapeMrkdwn(stripDashes(s));
}

function codeBlock(s: string): string {
  return "```" + escapeMrkdwn(s) + "```";
}

function chunk(s: string, size: number): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (cur.length > 0 && codeBlock(cur + ch).length > size) {
      parts.push(cur);
      cur = "";
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

function section(text: string) {
  return { type: "section", text: { type: "mrkdwn", text } };
}

export function renderApprovalCard(
  call: { input?: unknown },
  ui: { button: ButtonFactory },
  opts: { sendLocked?: (to: string) => boolean } = {},
): { text: string; blocks: unknown[] } {
  const parsed = approvalInput.safeParse(call.input);
  if (!parsed.success) throw new Error("requestOutreachApproval input is invalid");
  const { outreachId, candidate, evidence, contact, subject, body } = parsed.data;
  const h = draftHash(subject, body);

  const who = candidate.name
    ? `${display(candidate.name)} (\`${candidate.login}\`)`
    : `\`${candidate.login}\``;

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: "Outreach approval needed" } },
    section(`*Candidate:* ${who}${candidate.summary ? `\n${display(candidate.summary)}` : ""}`),
  ];
  evidence.forEach((e, i) => {
    const bullet = `• ${display(e.label)}`;
    blocks.push(section(i === 0 ? `*Evidence*\n${bullet}` : bullet));
  });
  if (evidence.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Links are on the candidate card above." }],
    });
  }
  blocks.push(
    section(
      `*Contact:* ${escapeMrkdwn(contact.value)}\n*Provenance:* ${escapeMrkdwn(contact.provenance)}`,
    ),
    section(`*Subject*\n${codeBlock(subject)}`),
  );
  const bodyParts = chunk(body, SECTION_LIMIT);
  bodyParts.forEach((part, i) => {
    blocks.push(section(`${i === 0 ? "*Body*\n" : ""}${codeBlock(part)}`));
  });
  const locked = opts.sendLocked?.(contact.value) === true;
  if (locked) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Sending is locked: approving will not email this person." }],
    });
  }
  blocks.push({
    type: "actions",
    elements: [
      ui.button({
        text: locked ? "Approve (sending locked)" : "Approve & send",
        style: "primary",
        output: {
          approved: true,
          id: outreachId,
          h,
          to: contact.value,
          login: candidate.login,
          ...(locked ? { locked: true } : {}),
        },
      }),
      ui.button({
        text: "Deny",
        output: { approved: false, id: outreachId, h, to: contact.value, login: candidate.login },
      }),
      ui.button({
        text: "Never show this person",
        style: "danger",
        confirm: {
          title: "Never show this person?",
          text: `${candidate.login} will be added to the do-not-contact list and never suggested again.`,
          confirm: "Add to list",
          deny: "Cancel",
        },
        output: {
          approved: false,
          suppress: true,
          id: outreachId,
          h,
          to: contact.value,
          login: candidate.login,
        },
      }),
    ],
  });

  return {
    text: `Outreach approval needed for ${escapeMrkdwn(candidate.login)}: ${display(subject)}`,
    blocks,
  };
}

export type Resolution = { toolCallId?: string; toolName?: string; output: unknown };

export function wrapResolution<R extends Resolution>(
  r: R | null | undefined,
  uid: string | undefined,
  approvers: ReadonlySet<string>,
  sendLocked: (to: string) => boolean = () => false,
): R | null {
  if (!r) return null;
  const out = r.output;
  if (typeof out !== "object" || out === null) return r;
  const authorized = uid !== undefined && approvers.has(uid);
  const approved = (out as { approved?: unknown }).approved === true && authorized;
  const suppress = (out as { suppress?: unknown }).suppress === true;
  const whatToSay = !authorized
    ? "The clicker is not an approver. Call requestOutreachApproval again with the same outreachId, subject and body."
    : approved
      ? (out as { locked?: unknown }).locked === true || sendLocked((out as { to?: string }).to ?? "")
        ? "Approved, but sending is locked; the record is closed and nothing was sent. Say that nothing was sent."
        : "Approved. Call sendOutreach with this outreachId now."
      : suppress
        ? "Added to the do-not-contact list by the approver. Nothing was sent. Say that in one sentence."
        : "Denied by the approver. Nothing was sent. Say that in one sentence; if the team wants another attempt they can ask for a new draft.";
  return { ...r, output: { ...out, approved, authorized, decidedBy: uid, whatToSay } };
}
