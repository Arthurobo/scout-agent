export type SendMode = "allowlist" | "open";

export type DemoConfig = {
  enabled: boolean;
  allowedLogins: string[];
  allowedRecipients: string[];
  sendMode: SendMode;
};

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function parseDemoMode(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "false") return false;
  if (v === "true") return true;
  throw new Error("DEMO_MODE must be true or false");
}

export function parseSendMode(value: string | undefined): SendMode {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "allowlist") return "allowlist";
  if (v === "open") return "open";
  throw new Error("SEND_MODE must be allowlist or open");
}

export function demoConfigFromEnv(env: Record<string, string | undefined> = process.env): DemoConfig {
  return {
    enabled: parseDemoMode(env.DEMO_MODE),
    allowedLogins: list(env.DEMO_ALLOWED_LOGINS),
    allowedRecipients: list(env.SEND_ALLOWED_RECIPIENTS),
    sendMode: parseSendMode(env.SEND_MODE),
  };
}

export function isRecipientAllowed(cfg: DemoConfig, recipient: string): boolean {
  if (cfg.sendMode === "open") return true;
  return cfg.allowedRecipients.includes(recipient.trim().toLowerCase());
}

export function isLoginAllowed(cfg: DemoConfig, login: string): boolean {
  if (!cfg.enabled) return true;
  return cfg.allowedLogins.includes(login.trim().toLowerCase());
}
