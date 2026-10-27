import { isLoginAllowed, type DemoConfig } from "../outreach/demo.js";

export type ProfileLike = {
  id: number;
  login: string;
  type: string;
  bio?: string | null;
  company?: string | null;
};

export type FilterContext = {
  excludedLogins: ReadonlySet<string>;
  suppressedIds: ReadonlySet<number>;
  liveIds: ReadonlySet<number>;
  demo: DemoConfig;
};

export type ExcludeReason =
  | "bot"
  | "organization"
  | "demo_not_allowed"
  | "triggerdotdev_person"
  | "mentions_triggerdotdev"
  | "suppressed"
  | "already_contacted";

const TRIGGER_MENTION = /trigger\.dev|triggerdotdev/i;

export function mentionsTriggerDev(text: string | null | undefined): boolean {
  return !!text && TRIGGER_MENTION.test(text);
}

export function excludeReason(p: ProfileLike, ctx: FilterContext): ExcludeReason | null {
  if (p.type === "Bot" || /\[bot\]$/i.test(p.login)) return "bot";
  if (p.type === "Organization") return "organization";
  if (!isLoginAllowed(ctx.demo, p.login)) return "demo_not_allowed";
  if (ctx.excludedLogins.has(p.login.toLowerCase())) return "triggerdotdev_person";
  if (mentionsTriggerDev(p.bio) || mentionsTriggerDev(p.company)) return "mentions_triggerdotdev";
  if (ctx.suppressedIds.has(p.id)) return "suppressed";
  if (ctx.liveIds.has(p.id)) return "already_contacted";
  return null;
}
