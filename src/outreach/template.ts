export const OPT_OUT_LINE = "Not interested? Reply 'no thanks' and you won't hear from us again.";

export function withOptOut(body: string): string {
  const trimmed = body.trimEnd();
  if (trimmed.endsWith(OPT_OUT_LINE)) return trimmed;
  return `${trimmed}\n\n${OPT_OUT_LINE}`;
}

export function withSignature(body: string, signature: string | undefined): string {
  if (!signature) return body;
  const trimmed = body.trimEnd();
  if (trimmed.endsWith(signature)) return trimmed;
  return `${trimmed}\n\n${signature}`;
}
