import { isSlackResponseUrl, slack, type SlackBlockActions } from "@trigger.dev/slack";
import { getDb } from "../db/client.js";
import { demoConfigFromEnv, isRecipientAllowed } from "../outreach/demo.js";
import { sanitizeReply } from "../text.js";
import type { ThreadInfo } from "./turn.js";
import { renderApprovalCard, wrapResolution } from "./approval.js";
import {
  dbDecisionStore,
  finalizeApproval,
  type ClickInfo,
  type DecisionStore,
  type ReplaceOriginal,
} from "./finalize.js";

type SlackOptions = Parameters<typeof slack>[0];

export type ScoutSlackOptions = Pick<SlackOptions, "id" | "endpoint" | "token" | "startOn"> & {
  approvers: () => ReadonlySet<string>;
  store?: DecisionStore;
  onThread?: (info: ThreadInfo) => void;
  sendLocked?: (to: string) => boolean;
};

export function makeReplaceOriginal(fetchImpl: typeof fetch = fetch): ReplaceOriginal {
  return async (click: ClickInfo, text: string) => {
    const url = click.responseUrl;
    if (!url || !isSlackResponseUrl(url)) return;
    const kept = (click.blocks ?? []).filter(
      (b) => !(typeof b === "object" && b !== null && (b as { type?: string }).type === "actions"),
    );
    const blocks = [...kept, { type: "context", elements: [{ type: "mrkdwn", text }] }];
    try {
      await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ replace_original: true, text, blocks }),
      });
    } catch {
      console.warn("replace_original failed");
    }
  };
}

function clickInfo(e: unknown): ClickInfo {
  const click = e as SlackBlockActions;
  return {
    userId: click.user?.id,
    responseUrl: click.response_url,
    blocks: click.message?.blocks,
  };
}

export function scoutSlack(opts: ScoutSlackOptions) {
  const {
    approvers,
    store = dbDecisionStore(getDb),
    onThread,
    sendLocked = (to: string) => !isRecipientAllowed(demoConfigFromEnv(), to),
    ...channel
  } = opts;
  const base = slack({
    ...channel,
    delivery: "final",
    outbound: (reply) => (reply.text ? { text: sanitizeReply(reply.text) } : null),
    interactions: {
      requestOutreachApproval: (call, ui) => renderApprovalCard(call, ui, { sendLocked }),
    },
  });
  const replaceOriginal = makeReplaceOriginal();

  return {
    ...base,
    inbound: (e: Parameters<typeof base.inbound>[0]) => {
      const handle = base.bind?.(e);
      if (handle) onThread?.({ channel: handle.channel, threadTs: handle.threadTs, userId: handle.userId });
      return base.inbound(e);
    },
    onInteraction: (e: Parameters<NonNullable<typeof base.onInteraction>>[0]) => {
      const resolution = base.onInteraction?.(e);
      if (!resolution) return null;
      return wrapResolution(resolution, clickInfo(e).userId, approvers(), sendLocked);
    },
    finalizeInteraction: async (
      e: Parameters<NonNullable<typeof base.finalizeInteraction>>[0],
      r: Parameters<NonNullable<typeof base.finalizeInteraction>>[1],
    ) =>
      finalizeApproval(clickInfo(e), r, {
        approvers: approvers(),
        store,
        replaceOriginal,
        sendLocked,
        baseFinalize: async () => {
          await base.finalizeInteraction?.(e, r);
        },
        log: (m) => console.warn(m),
      }),
  };
}
