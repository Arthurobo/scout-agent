import { webhooks } from "@trigger.dev/sdk";
import { appMentions, webhookSource } from "@trigger.dev/slack";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionResult, OutreachRow } from "../src/outreach/state.js";
import { scoutSlack } from "../src/slack/connector.js";
import type { DecisionStore } from "../src/slack/finalize.js";

const endpoint = webhooks.endpoint.define({ id: "slack-connector-test", source: webhookSource() });

const ok: DecisionResult = { ok: true, row: {} as OutreachRow };
const output = { approved: true, id: 7, h: "hash", to: "fake@example.test", login: "fake-dev-one" };

function click(userId: string | undefined, over: Record<string, unknown> = {}, out: object = output) {
  return {
    type: "block_actions",
    user: userId ? { id: userId } : undefined,
    response_url: "https://hooks.slack.com/actions/T/1/x",
    message: {
      ts: "1.2",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "card" } },
        { type: "actions", elements: [{ type: "button", value: JSON.stringify({ t: "call_1", o: out }) }] },
      ],
    },
    actions: [
      {
        action_id: "trigger_tool_0",
        text: { type: "plain_text", text: "Approve & send" },
        value: JSON.stringify({ t: "call_1", o: out }),
      },
    ],
    ...over,
  } as never;
}

function setup(store: Partial<DecisionStore> = {}) {
  const approvers = vi.fn(() => new Set(["U0APPROVER"]) as ReadonlySet<string>);
  const onThread = vi.fn();
  const full: DecisionStore = {
    approve: vi.fn(async () => ok),
    deny: vi.fn(async () => ok),
    suppress: vi.fn(async () => ok),
    approveLocked: vi.fn(async () => ok),
    ...store,
  };
  const connector = scoutSlack({
    id: "slack",
    endpoint,
    token: () => "xoxb-test-token",
    startOn: appMentions(),
    approvers,
    store: full,
    onThread,
    sendLocked: () => false,
  });
  return { connector, approvers, onThread, store: full };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

describe("scoutSlack onInteraction", () => {
  it("resolves an approver click with authorized true and the clicker id", () => {
    const { connector } = setup();
    const r = connector.onInteraction(click("U0APPROVER"));
    expect(r).toMatchObject({
      toolCallId: "call_1",
      output: { approved: true, authorized: true, decidedBy: "U0APPROVER", id: 7, h: "hash", to: "fake@example.test", login: "fake-dev-one" },
    });
  });

  it("forces approved false for a non-approver and for a click without a user", () => {
    const { connector } = setup();
    expect(connector.onInteraction(click("U0OTHER"))).toMatchObject({
      output: { approved: false, authorized: false, decidedBy: "U0OTHER" },
    });
    expect(connector.onInteraction(click(undefined))).toMatchObject({
      output: { approved: false, authorized: false },
    });
  });

  it("returns null for a plain message without reading the approver list", () => {
    const { connector, approvers } = setup();
    const message = { type: "event_callback", event: { type: "app_mention", user: "U0ASKER", text: "hi", channel: "C1", ts: "1.1" } };
    expect(connector.onInteraction(message as never)).toBeNull();
    expect(approvers).not.toHaveBeenCalled();
  });
});

describe("scoutSlack send lock", () => {
  it("passes the lock through to whatToSay for an approved click", () => {
    const connector = scoutSlack({
      id: "slack",
      endpoint,
      token: () => "xoxb-test-token",
      startOn: appMentions(),
      approvers: () => new Set(["U0APPROVER"]),
      store: { approve: vi.fn(async () => ok), approveLocked: vi.fn(async () => ok), deny: vi.fn(async () => ok), suppress: vi.fn(async () => ok) },
      sendLocked: (to) => to === "fake@example.test",
    });
    const r = connector.onInteraction(click("U0APPROVER"));
    expect((r?.output as { whatToSay: string }).whatToSay).toBe("Approved, but sending is locked; the record is closed and nothing was sent. Say that nothing was sent.");
    const open = connector.onInteraction(click("U0APPROVER", {}, { ...output, to: "other@example.test" }));
    expect((open?.output as { whatToSay: string }).whatToSay).toBe("Approved. Call sendOutreach with this outreachId now.");
  });
});

describe("scoutSlack finalizeInteraction", () => {
  it("approver click: records via the store, then runs the built-in finalize (Approved by)", async () => {
    const { connector, store } = setup();
    const event = click("U0APPROVER");
    const resolution = connector.onInteraction(event)!;
    await connector.finalizeInteraction(event, resolution);
    expect(store.approve).toHaveBeenCalledWith({
      outreachId: 7,
      draftHash: "hash",
      decidedBy: "U0APPROVER",
      to: "fake@example.test",
      login: "fake-dev-one",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = bodyOf(fetchMock.mock.calls[0]!);
    expect(body.text).toBe("Approved by <@U0APPROVER>");
    expect(body.blocks.some((b: { type: string }) => b.type === "actions")).toBe(false);
  });

  it("zero rows: shows the warning once and does not run the built-in finalize", async () => {
    const { connector } = setup({ approve: vi.fn(async () => ({ ok: false, reason: "draft_changed" }) as DecisionResult) });
    const event = click("U0APPROVER");
    await connector.finalizeInteraction(event, connector.onInteraction(event)!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = bodyOf(fetchMock.mock.calls[0]!);
    expect(body.text).toBe("⚠️ Not approved: draft changed or expired");
    expect(JSON.stringify(body)).not.toContain("Approved by");
  });

  it("non-approver click: no store call, notice only", async () => {
    const { connector, store } = setup();
    const event = click("U0OTHER");
    await connector.finalizeInteraction(event, connector.onInteraction(event)!);
    expect(store.approve).not.toHaveBeenCalled();
    expect(store.deny).not.toHaveBeenCalled();
    expect(store.suppress).not.toHaveBeenCalled();
    expect(bodyOf(fetchMock.mock.calls[0]!).text).toBe("⛔ <@U0OTHER> is not an approver. A fresh card follows.");
  });

  it("deny and never-show clicks reach their store functions", async () => {
    const { connector, store } = setup();
    const deny = click("U0APPROVER", {}, { ...output, approved: false });
    await connector.finalizeInteraction(deny, connector.onInteraction(deny)!);
    const never = click("U0APPROVER", {}, { ...output, approved: false, suppress: true });
    await connector.finalizeInteraction(never, connector.onInteraction(never)!);
    expect(store.deny).toHaveBeenCalledTimes(1);
    expect(store.suppress).toHaveBeenCalledTimes(1);
    expect(store.approve).not.toHaveBeenCalled();
  });

  it("a store that throws shows 'Could not record' and never leaks the error", async () => {
    const { connector } = setup({
      approve: vi.fn(async () => {
        throw new Error("password=secret-db-pass");
      }),
    });
    const event = click("U0APPROVER");
    await connector.finalizeInteraction(event, connector.onInteraction(event)!);
    expect(bodyOf(fetchMock.mock.calls[0]!).text).toBe("⚠️ Could not record the decision");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("secret-db-pass");
  });
});

describe("scoutSlack inbound", () => {
  it("reports the thread to onThread and still returns the base message", () => {
    const { connector, onThread } = setup();
    const event = {
      type: "event_callback",
      team_id: "T1",
      event: { type: "app_mention", user: "U0ASKER", text: "<@U0BOT> find engineers", channel: "C0FAKE", ts: "1700000000.000100" },
    };
    const inbound = connector.inbound(event as never);
    expect(onThread).toHaveBeenCalledWith({ channel: "C0FAKE", threadTs: "1700000000.000100", userId: "U0ASKER" });
    expect(JSON.stringify(inbound)).toContain("find engineers");
  });

  it("uses thread_ts when the mention is inside an existing thread", () => {
    const { connector, onThread } = setup();
    const event = {
      type: "event_callback",
      event: { type: "message", user: "U0ASKER", text: "more", channel: "C0FAKE", ts: "1700000009.000200", thread_ts: "1700000000.000100" },
    };
    connector.inbound(event as never);
    expect(onThread).toHaveBeenCalledWith({ channel: "C0FAKE", threadTs: "1700000000.000100", userId: "U0ASKER" });
  });
});

describe("scoutSlack outbound sanitising", () => {
  const reply = (text: string) => ({ text, message: {} as never, final: true, stopped: false });

  it("removes addresses and wraps URLs in what Scout posts", () => {
    const { connector } = setup();
    expect(connector.outbound?.(reply("Approved and sent to Arthurobo at mailto:john.doe@example.com"))).toEqual({
      text: "Approved and sent to Arthurobo at the address on the approval card",
    });
    expect(connector.outbound?.(reply("Repo: https://github.com/fake/repo"))).toEqual({
      text: "Repo: `https://github.com/fake/repo`",
    });
    expect(connector.outbound?.(reply(""))).toBeNull();
  });
});
