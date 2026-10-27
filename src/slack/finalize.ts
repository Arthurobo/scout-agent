import type { Db } from "../db/client.js";
import {
  recordApproval,
  recordDenial,
  recordLockedApproval,
  recordSuppression,
  type BoundDecisionInput,
  type DecisionInput,
  type DecisionResult,
} from "../outreach/state.js";
import { approvalOutput, type Resolution } from "./approval.js";

export type DecisionStore = {
  approve: (input: BoundDecisionInput) => Promise<DecisionResult>;
  approveLocked: (input: BoundDecisionInput) => Promise<DecisionResult>;
  deny: (input: DecisionInput) => Promise<DecisionResult>;
  suppress: (input: BoundDecisionInput) => Promise<DecisionResult>;
};

export function dbDecisionStore(getDb: () => Db): DecisionStore {
  return {
    approve: (i) => recordApproval(getDb(), i),
    approveLocked: (i) => recordLockedApproval(getDb(), i),
    deny: (i) => recordDenial(getDb(), i),
    suppress: (i) => recordSuppression(getDb(), i),
  };
}

export type ClickInfo = {
  userId?: string;
  responseUrl?: string;
  blocks?: unknown[];
};

export type ReplaceOriginal = (click: ClickInfo, text: string) => Promise<void>;

export type FinalizeDeps = {
  approvers: ReadonlySet<string>;
  store: DecisionStore;
  replaceOriginal: ReplaceOriginal;
  baseFinalize: () => Promise<void> | void;
  sendLocked?: (to: string) => boolean;
  log?: (message: string) => void;
};

export function notApprovedText(reason: Extract<DecisionResult, { ok: false }>["reason"]): string {
  if (reason === "already_contacted") return "⚠️ Not approved: already contacted";
  if (reason === "suppressed") return "⚠️ Not approved: on the do-not-contact list";
  if (reason === "not_found") return "⚠️ Not approved: draft not found";
  return "⚠️ Not approved: draft changed or expired";
}

export async function finalizeApproval(
  click: ClickInfo,
  resolution: Resolution,
  deps: FinalizeDeps,
): Promise<void> {
  const { approvers, store, replaceOriginal, baseFinalize, log, sendLocked } = deps;
  const parsed = approvalOutput.safeParse(resolution.output);
  if (!parsed.success) {
    await replaceOriginal(click, "⚠️ Could not record the decision");
    return;
  }
  const { id, h, to, login, approved, suppress } = parsed.data;
  const renderedLocked = parsed.data.locked === true;

  if (click.userId === undefined || !approvers.has(click.userId)) {
    await replaceOriginal(click, `⛔ <@${click.userId ?? "unknown"}> is not an approver. A fresh card follows.`);
    return;
  }

  const input: BoundDecisionInput = { outreachId: id, draftHash: h, decidedBy: click.userId, to, login };
  const locked = !suppress && approved && (renderedLocked || sendLocked?.(to) === true);
  let result: DecisionResult;
  try {
    result = suppress
      ? await store.suppress(input)
      : locked
        ? await store.approveLocked(input)
        : approved
          ? await store.approve(input)
          : await store.deny(input);
  } catch (err) {
    log?.(`finalizeInteraction decision failed: ${err instanceof Error ? err.name : "error"}`);
    await replaceOriginal(click, "⚠️ Could not record the decision");
    return;
  }

  if (!result.ok) {
    const text = approved && !suppress ? notApprovedText(result.reason) : "⚠️ Not recorded: draft changed or already decided";
    await replaceOriginal(click, text);
    return;
  }

  if (locked) {
    await replaceOriginal(click, `Approved by <@${click.userId}>, but sending is locked: nothing was sent.`);
    return;
  }

  await baseFinalize();
}
