import { z } from "zod";
import type { Mailbox } from "../config.js";
import type { SendOutcome } from "../outreach/state.js";

const ENDPOINT = "https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails";

export type ScalewayConfig = {
  secretKey: string;
  projectId: string;
  from: Mailbox;
  replyTo: string;
  auditHeader: boolean;
};

export type SendEmailInput = {
  outreachId: number;
  draftHash: string;
  to: string;
  subject: string;
  text: string;
};

export type SendResult = { outcome: SendOutcome; messageId?: string };

export type ScalewayOptions = { fetch?: typeof fetch; timeoutMs?: number };

const successBody = z.object({
  emails: z.array(z.object({ id: z.string().min(1), message_id: z.string().optional() }).passthrough()).min(1),
});

const errorBody = z.object({ type: z.string().optional(), message: z.string().optional() });

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function buildRequestBody(cfg: ScalewayConfig, input: SendEmailInput) {
  const headers = [
    { key: "Reply-To", value: cfg.replyTo },
    { key: "List-Unsubscribe", value: `<mailto:${cfg.replyTo}?subject=unsubscribe>` },
  ];
  if (cfg.auditHeader) headers.push({ key: "X-Scout-Outreach", value: `${input.outreachId}:${input.draftHash}` });
  return {
    from: cfg.from.name ? { email: cfg.from.email, name: cfg.from.name } : { email: cfg.from.email },
    to: [{ email: input.to }],
    subject: input.subject,
    text: input.text,
    project_id: cfg.projectId,
    additional_headers: headers,
  };
}

export async function sendEmail(
  cfg: ScalewayConfig,
  input: SendEmailInput,
  opts: ScalewayOptions = {},
): Promise<SendResult> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(ENDPOINT, {
      method: "POST",
      headers: { "x-auth-token": cfg.secretKey, "content-type": "application/json" },
      body: JSON.stringify(buildRequestBody(cfg, input)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return { outcome: { kind: "timeout", error: timedOut ? "provider request timed out" : "connection error" } };
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    raw = undefined;
  }

  if (res.status >= 200 && res.status < 300) {
    const parsed = successBody.safeParse(raw);
    if (!parsed.success) return { outcome: { kind: "http", status: res.status } };
    const first = parsed.data.emails[0]!;
    return {
      outcome: { kind: "http", status: res.status, providerMessageId: first.id },
      messageId: first.message_id,
    };
  }

  const err = errorBody.safeParse(raw);
  const body = err.success ? err.data : {};
  const type = body.type && /^[a-z_]{1,64}$/.test(body.type) ? body.type : undefined;
  const message = body.message ? clip(body.message.split(cfg.secretKey).join("[redacted]"), 300) : undefined;
  return { outcome: { kind: "http", status: res.status, errorType: type, errorMessage: message } };
}
