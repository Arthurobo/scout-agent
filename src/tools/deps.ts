import { chat } from "@trigger.dev/sdk/ai";
import type { SlackRunSurface } from "@trigger.dev/slack";
import { loadConfig, parseMailbox } from "../config.js";
import { getDb, type Db } from "../db/client.js";
import { sendEmail, type ScalewayConfig, type SendEmailInput, type SendResult } from "../email/scaleway.js";
import { createGitHubClient, type GitHubClient } from "../github/client.js";
import { demoConfigFromEnv, type DemoConfig } from "../outreach/demo.js";
import { NoThreadError, postToThread } from "../slack/post.js";
import { turnStore, type TurnStore } from "../slack/turn.js";

export type PostMessage = { text: string; blocks?: unknown[] };

export type ToolDeps = {
  db: () => Db;
  github: () => GitHubClient;
  demo: () => DemoConfig;
  turn: TurnStore;
  post: (message: PostMessage) => Promise<{ ts: string }>;
  sendConfig: () => ScalewayConfig;
  send: (cfg: ScalewayConfig, input: SendEmailInput) => Promise<SendResult>;
  now: () => Date;
  signature: () => string | undefined;
};

export function scalewayConfigFromEnv(env: Record<string, string | undefined> = process.env): ScalewayConfig {
  const c = loadConfig(["SCW_SECRET_KEY", "SCW_PROJECT_ID", "EMAIL_FROM", "REPLY_TO", "SCOUT_AUDIT_HEADER"], env);
  return {
    secretKey: c.SCW_SECRET_KEY,
    projectId: c.SCW_PROJECT_ID,
    from: parseMailbox(c.EMAIL_FROM),
    replyTo: c.REPLY_TO,
    auditHeader: c.SCOUT_AUDIT_HEADER === "true",
  };
}

export function signatureFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const { OUTREACH_SIGNATURE } = loadConfig(["OUTREACH_SIGNATURE"], env);
  const one = OUTREACH_SIGNATURE?.replace(/\s+/g, " ").trim();
  return one || undefined;
}

let githubClient: GitHubClient | undefined;

export function defaultDeps(): ToolDeps {
  return {
    db: getDb,
    github: () => (githubClient ??= createGitHubClient({ token: loadConfig(["GITHUB_TOKEN"]).GITHUB_TOKEN })),
    demo: () => demoConfigFromEnv(),
    turn: turnStore,
    post: async (message) => {
      const thread = turnStore.get().thread;
      if (thread) {
        const { SLACK_BOT_TOKEN } = loadConfig(["SLACK_BOT_TOKEN"]);
        return postToThread(SLACK_BOT_TOKEN, { channel: thread.channel, thread_ts: thread.threadTs, ...message });
      }
      const surface = chat.surface<SlackRunSurface>();
      if (!surface) throw new NoThreadError();
      return surface.post(message);
    },
    sendConfig: scalewayConfigFromEnv,
    send: (cfg, input) => sendEmail(cfg, input),
    now: () => new Date(),
    signature: () => signatureFromEnv(),
  };
}
