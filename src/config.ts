import { z } from "zod";

const text = z.string().trim().min(1);

const csv = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const fields = {
  SLACK_BOT_TOKEN: text,
  GITHUB_TOKEN: text,
  OPENROUTER_API_KEY: text,
  MODEL_ID: text.default("deepseek/deepseek-v4.1-flash"),
  SCW_SECRET_KEY: text,
  SCW_PROJECT_ID: text,
  EMAIL_FROM: text,
  REPLY_TO: text.pipe(z.email()),
  SCOUT_AUDIT_HEADER: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() || undefined : v),
    z.enum(["true", "false"]).default("true"),
  ),
  DATABASE_URL: text,
  APPROVER_SLACK_IDS: csv.refine((ids) => ids.length > 0, "must list at least one Slack user id"),
  DEMO_MODE: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() || undefined : v),
    z.enum(["true", "false"]).default("false"),
  ),
  DEMO_ALLOWED_LOGINS: csv,
  SEND_ALLOWED_RECIPIENTS: csv,
  SEND_MODE: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() || undefined : v),
    z.enum(["allowlist", "open"]).default("allowlist"),
  ),
  OUTREACH_SIGNATURE: z
    .string()
    .trim()
    .max(200)
    .refine((v) => !/```|[\r\n]/.test(v), "must be one line without a code fence")
    .optional(),
} as const;

export type EnvName = keyof typeof fields;

export type Config<K extends EnvName> = { [P in K]: z.output<(typeof fields)[P]> };

export class ConfigError extends Error {
  readonly names: string[];
  constructor(names: string[]) {
    super(`Missing or invalid environment variables: ${names.join(", ")}`);
    this.name = "ConfigError";
    this.names = names;
  }
}

export function loadConfig<const K extends EnvName>(
  keys: readonly K[],
  env: Record<string, string | undefined> = process.env,
): Config<K> {
  const out: Record<string, unknown> = {};
  const bad: string[] = [];
  for (const key of keys) {
    const raw = env[key];
    const parsed = fields[key].safeParse(raw === "" ? undefined : raw);
    if (parsed.success) out[key] = parsed.data;
    else bad.push(key);
  }
  if (bad.length > 0) throw new ConfigError(bad);
  return out as Config<K>;
}

export function missingEnv(
  keys: readonly EnvName[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  try {
    loadConfig(keys, env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.names;
    throw err;
  }
}

export const ALL_ENV_NAMES = Object.keys(fields) as EnvName[];

export type Mailbox = { email: string; name?: string };

export function parseMailbox(value: string): Mailbox {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+)>\s*$/.exec(value);
  const email = (m ? m[2] : value.trim()) as string;
  const name = m?.[1]?.trim();
  if (!z.email().safeParse(email).success) throw new ConfigError(["EMAIL_FROM"]);
  return name ? { email, name } : { email };
}

export function requireGitHubToken(env: Record<string, string | undefined> = process.env): void {
  loadConfig(["GITHUB_TOKEN"], env);
}
