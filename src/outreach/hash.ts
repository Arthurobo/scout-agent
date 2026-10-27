import { createHash } from "node:crypto";

export function draftHash(subject: string, body: string): string {
  return createHash("sha256").update(`${subject}\n${body}`).digest("hex");
}
