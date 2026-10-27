import { describe, expect, it, vi } from "vitest";
import { draftHash } from "../src/outreach/hash.js";
import type { DecisionResult, OutreachRow } from "../src/outreach/state.js";
import { approvalInput, renderApprovalCard, wrapResolution, type ButtonFactory } from "../src/slack/approval.js";
import {
  finalizeApproval,
  type ClickInfo,
  type DecisionStore,
  type FinalizeDeps,
} from "../src/slack/finalize.js";
import { makeReplaceOriginal } from "../src/slack/connector.js";

const input = {
  outreachId: 42,
  candidate: { login: "fake-dev-one", name: "Fake Dev", summary: "Builds fake agent tooling" },
  evidence: [{ label: "fake-repo", url: "https://github.com/fake-dev-one/fake-repo" }],
  contact: { value: "fake.dev.one@example.test", provenance: "email published on GitHub profile" },
  subject: "Hello <b>there</b>",
  body: "Line one\nLine two with & <link>",
};

type Button = { text: string; style?: string; confirm?: unknown; output: unknown };
const button: ButtonFactory = (o) => o as Button;

function buttonsOf(card: { blocks: unknown[] }): Button[] {
  const actions = card.blocks.find((b) => (b as { type: string }).type === "actions") as {
    elements: Button[];
  };
  return actions.elements;
}

describe("renderApprovalCard", () => {
  const card = renderApprovalCard({ input }, { button });
  const h = draftHash(input.subject, input.body);

  it("builds three buttons with the expected outputs and hash", () => {
    const [approve, deny, never] = buttonsOf(card);
    const bound = { id: 42, h, to: "fake.dev.one@example.test", login: "fake-dev-one" };
    expect(approve).toMatchObject({ style: "primary", output: { approved: true, ...bound } });
    expect(deny?.output).toEqual({ approved: false, ...bound });
    expect(never).toMatchObject({
      style: "danger",
      output: { approved: false, suppress: true, ...bound },
    });
  });

  it("puts a confirm dialog on the danger button only", () => {
    const [approve, deny, never] = buttonsOf(card);
    expect(approve?.confirm).toBeUndefined();
    expect(deny?.confirm).toBeUndefined();
    expect(never?.confirm).toMatchObject({ title: expect.any(String), text: expect.any(String) });
  });

  it("shows candidate, evidence, contact, provenance, subject and body, escaped", () => {
    const text = JSON.stringify(card.blocks);
    expect(text).toContain("fake-dev-one");
    expect(text).toContain("`fake-dev-one`");
    expect(text).toContain("fake-repo");
    expect(text).toContain("Links are on the candidate card above.");
    expect(text).toContain("fake.dev.one@example.test");
    expect(text).toContain("email published on GitHub profile");
    expect(text).toContain("Hello &lt;b&gt;there&lt;/b&gt;");
    expect(text).toContain("&amp; &lt;link&gt;");
    expect(text).not.toContain("<link>");
  });

  it("contains no hyperlinks at all, so nothing can unfurl", () => {
    const all = JSON.stringify(card.blocks);
    expect(all).not.toContain("https://");
    expect(all).not.toContain("http://");
    expect(all).not.toMatch(/<https?:/);
    expect(all).not.toContain("|fake-dev-one>");
  });

  it("shows the lock line and a relabelled Approve button only when sending is locked", () => {
    const locked = renderApprovalCard({ input }, { button }, { sendLocked: () => true });
    const open = renderApprovalCard({ input }, { button }, { sendLocked: () => false });
    const t = JSON.stringify(locked.blocks);
    expect(t).toContain("Sending is locked: approving will not email this person.");
    expect(buttonsOf(locked)[0]?.text).toBe("Approve (sending locked)");
    expect(buttonsOf(locked)[0]?.output).toEqual({ ...(buttonsOf(open)[0]!.output as object), locked: true });
    expect(buttonsOf(open)[0]?.output).not.toHaveProperty("locked");
    expect(buttonsOf(locked)[1]?.output).not.toHaveProperty("locked");
    expect(JSON.stringify(open.blocks)).not.toContain("Sending is locked");
    expect(buttonsOf(open)[0]?.text).toBe("Approve & send");
    expect(buttonsOf(renderApprovalCard({ input }, { button }))[0]?.text).toBe("Approve & send");
    expect(t).not.toContain("https://");
    expect(t.split("fake.dev.one@example.test").length).toBe(JSON.stringify(open.blocks).split("fake.dev.one@example.test").length);
  });

  it("whatToSay for an approved click on a locked recipient closes the record", () => {
    const r = wrapResolution({ output: { approved: true, id: 1, h: "h", to: "x@example.test", login: "a" } }, "U0APPROVER", new Set(["U0APPROVER"]), () => true);
    expect((r?.output as unknown as { whatToSay: string }).whatToSay).toBe(
      "Approved, but sending is locked; the record is closed and nothing was sent. Say that nothing was sent.",
    );
    const deny = wrapResolution({ output: { approved: false, id: 1, h: "h", to: "x@example.test", login: "a" } }, "U0APPROVER", new Set(["U0APPROVER"]), () => true);
    expect((deny?.output as unknown as { whatToSay: string }).whatToSay).toMatch(/^Denied by the approver/);
  });

  it("omits the links note when there is no evidence", () => {
    const bare = renderApprovalCard({ input: { ...input, evidence: [] } }, { button });
    expect(JSON.stringify(bare.blocks)).not.toContain("Links are on the candidate card");
  });

  it("keeps button values small", () => {
    for (const b of buttonsOf(card)) {
      expect(JSON.stringify({ t: "call_0123456789abcdef", o: b.output }).length).toBeLessThan(500);
    }
  });

  it("splits a long body across sections under Slack's limit", () => {
    const long = renderApprovalCard({ input: { ...input, body: "Z".repeat(7000) } }, { button });
    const sections = long.blocks.filter((b) => (b as { type: string }).type === "section") as {
      text: { text: string };
    }[];
    expect(sections.every((s) => s.text.text.length <= 3000)).toBe(true);
    expect(sections.map((s) => s.text.text).join("").match(/Z/g)).toHaveLength(7000);
  });

  it("keeps sections under the limit even when escaping inflates the body", () => {
    const long = renderApprovalCard({ input: { ...input, subject: "Plain", body: "<".repeat(5000) } }, { button });
    const sections = long.blocks.filter((b) => (b as { type: string }).type === "section") as {
      text: { text: string };
    }[];
    expect(sections.every((s) => s.text.text.length <= 3000)).toBe(true);
    expect(sections.map((s) => s.text.text).join("").match(/&lt;/g)).toHaveLength(5000);
  });

  it("escapes mentions in the fallback text and rejects non-GitHub logins", () => {
    const hostile = renderApprovalCard(
      { input: { ...input, subject: "Quick question <!channel> <@U0VICTIM> &amp;" } },
      { button },
    );
    const all = JSON.stringify(hostile);
    expect(all).not.toContain("<!channel>");
    expect(all).not.toContain("<@U0VICTIM>");
    expect(hostile.text).toContain("&lt;!channel&gt;");
    for (const login of ["<!here>", "bad login", "a".repeat(40), "", "x<y"]) {
      expect(approvalInput.safeParse({ ...input, candidate: { ...input.candidate, login } }).success, login).toBe(false);
    }
    expect(approvalInput.safeParse({ ...input, candidate: { ...input.candidate, login: "Fake-Dev-1" } }).success).toBe(true);
  });

  it("rejects evidence URLs that could spoof or break Slack link syntax", () => {
    const bad = [
      "https://evil.example.test|github.com/real-user",
      "https://github.com/a/b> <!channel> <https://x",
      "https://github.com/a b",
      "https://evil.example.test/x",
      "https://github.com.evil.example.test/x",
      "http://github.com/a/b",
    ];
    for (const url of bad) {
      expect(() => renderApprovalCard({ input: { ...input, evidence: [{ label: "x", url }] } }, { button }), url).toThrow();
    }
    expect(() =>
      renderApprovalCard({ input: { ...input, evidence: [{ label: "x", url: "https://gist.github.com/a/b" }] } }, { button }),
    ).not.toThrow();
  });

  it("rejects URLs in name, summary, evidence labels, provenance and subject, but not in the body", () => {
    const url = "see https://example.test/x";
    const www = "see WWW.example.test";
    const cases: Record<string, unknown>[] = [
      { candidate: { ...input.candidate, name: url } },
      { candidate: { ...input.candidate, summary: www } },
      { evidence: [{ label: url, url: input.evidence[0]!.url }] },
      { evidence: [{ label: www, url: input.evidence[0]!.url }] },
      { contact: { ...input.contact, provenance: url } },
      { subject: url },
      { subject: www },
    ];
    for (const patch of cases) {
      expect(approvalInput.safeParse({ ...input, ...patch }).success, JSON.stringify(patch).slice(0, 70)).toBe(false);
    }
    expect(approvalInput.safeParse({ ...input, body: "Read https://example.test/x and www.example.test" }).success).toBe(true);
  });

  it("rejects over-limit fields and code fences so the model gets a validation error", () => {
    const over: Record<string, unknown>[] = [
      { candidate: { ...input.candidate, login: "a".repeat(40) } },
      { candidate: { ...input.candidate, name: "n".repeat(101) } },
      { candidate: { ...input.candidate, summary: "s".repeat(501) } },
      { evidence: Array.from({ length: 7 }, () => input.evidence[0]) },
      { evidence: [{ label: "l".repeat(101), url: input.evidence[0]!.url }] },
      { contact: { ...input.contact, value: "v".repeat(255) } },
      { contact: { ...input.contact, provenance: "p".repeat(201) } },
      { subject: "s".repeat(201) },
      { body: "b".repeat(8001) },
      { subject: "has ``` fence" },
      { body: "has ``` fence" },
    ];
    for (const patch of over) {
      expect(approvalInput.safeParse({ ...input, ...patch }).success, JSON.stringify(patch).slice(0, 60)).toBe(false);
    }
    expect(approvalInput.safeParse({ ...input, body: "b".repeat(8000), subject: "s".repeat(200) }).success).toBe(true);
  });

  it("keeps every section under 3000 characters and the card under 50 blocks at the limits", () => {
    const worst = {
      ...input,
      candidate: { login: "a".repeat(39), name: "<".repeat(100), summary: "<".repeat(500) },
      evidence: Array.from({ length: 6 }, () => ({ label: "<".repeat(100), url: `https://github.com/${"a".repeat(470)}` })),
      contact: { value: "<".repeat(254), provenance: "<".repeat(200) },
      subject: "<".repeat(200),
      body: "<".repeat(8000),
    };
    const card = renderApprovalCard({ input: worst }, { button });
    const sections = card.blocks.filter((b) => (b as { type: string }).type === "section") as { text: { text: string } }[];
    expect(sections.every((s) => s.text.text.length <= 3000)).toBe(true);
    expect(card.blocks.length).toBeLessThan(50);
  });

  it("throws on invalid input and on non-https evidence", () => {
    expect(() => renderApprovalCard({ input: { outreachId: "nope" } }, { button })).toThrow();
    expect(() =>
      renderApprovalCard(
        { input: { ...input, evidence: [{ label: "x", url: "javascript:alert(1)" }] } },
        { button },
      ),
    ).toThrow();
  });
});

describe("wrapResolution truth table", () => {
  const approvers = new Set(["U0APPROVER"]);
  const outputs = {
    approve: { approved: true, id: 1, h: "h" },
    deny: { approved: false, id: 1, h: "h" },
    suppress: { approved: false, suppress: true, id: 1, h: "h" },
  };

  it.each([
    ["approver", "U0APPROVER", "approve", true, true],
    ["approver", "U0APPROVER", "deny", false, true],
    ["approver", "U0APPROVER", "suppress", false, true],
    ["non-approver", "U0OTHER", "approve", false, false],
    ["non-approver", "U0OTHER", "deny", false, false],
    ["non-approver", "U0OTHER", "suppress", false, false],
    ["unknown user", undefined, "approve", false, false],
  ] as const)("%s %s %s -> approved %s authorized %s", (_who, uid, action, approved, authorized) => {
    const r = wrapResolution({ toolCallId: "t1", output: outputs[action] }, uid, approvers);
    expect(r?.output).toMatchObject({ approved, authorized, decidedBy: uid, id: 1, h: "h" });
    expect(r?.toolCallId).toBe("t1");
  });

  it.each([
    ["approver", "approve", "Approved. Call sendOutreach with this outreachId now."],
    ["approver", "deny", "Denied by the approver. Nothing was sent. Say that in one sentence; if the team wants another attempt they can ask for a new draft."],
    ["approver", "suppress", "Added to the do-not-contact list by the approver. Nothing was sent. Say that in one sentence."],
    ["other", "approve", "The clicker is not an approver. Call requestOutreachApproval again with the same outreachId, subject and body."],
    ["other", "deny", "The clicker is not an approver. Call requestOutreachApproval again with the same outreachId, subject and body."],
    ["other", "suppress", "The clicker is not an approver. Call requestOutreachApproval again with the same outreachId, subject and body."],
  ] as const)("whatToSay for %s %s comes from code", (who, action, text) => {
    const r = wrapResolution({ output: outputs[action] }, who === "approver" ? "U0APPROVER" : "U0OTHER", approvers);
    expect((r?.output as unknown as { whatToSay: string }).whatToSay).toBe(text);
  });

  it("keeps suppress on the output", () => {
    const r = wrapResolution({ output: outputs.suppress }, "U0APPROVER", approvers);
    expect((r?.output as { suppress?: boolean }).suppress).toBe(true);
  });

  it("returns null for no resolution and passes non-object outputs through", () => {
    expect(wrapResolution(null, "U0APPROVER", approvers)).toBeNull();
    expect(wrapResolution(undefined, "U0APPROVER", approvers)).toBeNull();
    const odd = { output: "text" };
    expect(wrapResolution(odd, "U0APPROVER", approvers)).toBe(odd);
  });
});

describe("finalizeApproval", () => {
  const row = {} as OutreachRow;
  const ok: DecisionResult = { ok: true, row };
  const click: ClickInfo = { userId: "U0APPROVER", responseUrl: "https://hooks.slack.com/x", blocks: [] };

  function setup(over: Partial<Record<keyof DecisionStore, () => Promise<DecisionResult>>> = {}) {
    const store: DecisionStore = {
      approve: vi.fn(over.approve ?? (async () => ok)),
      deny: vi.fn(over.deny ?? (async () => ok)),
      suppress: vi.fn(over.suppress ?? (async () => ok)),
      approveLocked: vi.fn(over.approveLocked ?? (async () => ok)),
    };
    const replaceOriginal = vi.fn(async () => {});
    const baseFinalize = vi.fn(async () => {});
    const deps: FinalizeDeps = {
      approvers: new Set(["U0APPROVER"]),
      store,
      replaceOriginal,
      baseFinalize,
    };
    return { store, replaceOriginal, baseFinalize, deps };
  }

  const wrapped = (output: object) => ({
    toolCallId: "t1",
    output: { id: 7, h: "hash", to: "fake.dev.one@example.test", login: "fake-dev-one", ...output },
  });

  it("approve success: records approval, calls base finalize, no replace", async () => {
    const s = setup();
    await finalizeApproval(click, wrapped({ approved: true, authorized: true }), s.deps);
    expect(s.store.approve).toHaveBeenCalledWith({
      outreachId: 7,
      draftHash: "hash",
      decidedBy: "U0APPROVER",
      to: "fake.dev.one@example.test",
      login: "fake-dev-one",
    });
    expect(s.baseFinalize).toHaveBeenCalledTimes(1);
    expect(s.replaceOriginal).not.toHaveBeenCalled();
  });

  it("deny success: records denial and calls base finalize", async () => {
    const s = setup();
    await finalizeApproval(click, wrapped({ approved: false, authorized: true }), s.deps);
    expect(s.store.deny).toHaveBeenCalledTimes(1);
    expect(s.store.approve).not.toHaveBeenCalled();
    expect(s.baseFinalize).toHaveBeenCalledTimes(1);
  });

  it("suppress success: records suppression and calls base finalize", async () => {
    const s = setup();
    await finalizeApproval(click, wrapped({ approved: false, suppress: true, authorized: true }), s.deps);
    expect(s.store.suppress).toHaveBeenCalledTimes(1);
    expect(s.store.deny).not.toHaveBeenCalled();
    expect(s.baseFinalize).toHaveBeenCalledTimes(1);
  });

  it.each(["approve", "deny", "suppress"] as const)("non-approver %s: no DB call, notice, no base finalize", async (kind) => {
    const s = setup();
    const output =
      kind === "approve"
        ? { approved: false, authorized: false }
        : kind === "deny"
          ? { approved: false, authorized: false }
          : { approved: false, suppress: true, authorized: false };
    await finalizeApproval({ ...click, userId: "U0OTHER" }, wrapped(output), s.deps);
    expect(s.store.approve).not.toHaveBeenCalled();
    expect(s.store.deny).not.toHaveBeenCalled();
    expect(s.store.suppress).not.toHaveBeenCalled();
    expect(s.baseFinalize).not.toHaveBeenCalled();
    expect(s.replaceOriginal).toHaveBeenCalledWith(
      expect.anything(),
      "⛔ <@U0OTHER> is not an approver. A fresh card follows.",
    );
  });

  it.each([
    ["draft_changed", "⚠️ Not approved: draft changed or expired"],
    ["not_pending", "⚠️ Not approved: draft changed or expired"],
    ["expired", "⚠️ Not approved: draft changed or expired"],
    ["already_contacted", "⚠️ Not approved: already contacted"],
    ["suppressed", "⚠️ Not approved: on the do-not-contact list"],
  ] as const)("approve zero rows (%s): own notice, no base finalize", async (reason, text) => {
    const s = setup({ approve: async () => ({ ok: false, reason }) });
    await finalizeApproval(click, wrapped({ approved: true, authorized: true }), s.deps);
    expect(s.replaceOriginal).toHaveBeenCalledWith(expect.anything(), text);
    expect(s.baseFinalize).not.toHaveBeenCalled();
  });

  it("approve DB error: notice without leaking the error, no base finalize", async () => {
    const s = setup({
      approve: async () => {
        throw new Error("connection to secret-host refused");
      },
    });
    await finalizeApproval(click, wrapped({ approved: true, authorized: true }), s.deps);
    expect(s.replaceOriginal).toHaveBeenCalledWith(expect.anything(), "⚠️ Could not record the decision");
    expect(s.baseFinalize).not.toHaveBeenCalled();
  });

  it("deny and suppress failures also skip base finalize", async () => {
    const fail = async (): Promise<DecisionResult> => ({ ok: false, reason: "not_pending" });
    const a = setup({ deny: fail });
    await finalizeApproval(click, wrapped({ approved: false, authorized: true }), a.deps);
    expect(a.baseFinalize).not.toHaveBeenCalled();
    expect(a.replaceOriginal).toHaveBeenCalledTimes(1);
    const b = setup({ suppress: fail });
    await finalizeApproval(click, wrapped({ approved: false, suppress: true, authorized: true }), b.deps);
    expect(b.baseFinalize).not.toHaveBeenCalled();
    expect(b.replaceOriginal).toHaveBeenCalledTimes(1);
  });

  it("suppress passes the bound recipient and login to the store", async () => {
    const s = setup();
    await finalizeApproval(click, wrapped({ approved: false, suppress: true, authorized: true }), s.deps);
    expect(s.store.suppress).toHaveBeenCalledWith({
      outreachId: 7,
      draftHash: "hash",
      decidedBy: "U0APPROVER",
      to: "fake.dev.one@example.test",
      login: "fake-dev-one",
    });
  });

  it("output without to or login is malformed: no DB call, notice, no base finalize", async () => {
    const s = setup();
    await finalizeApproval(click, { output: { approved: true, id: 7, h: "hash", authorized: true } }, s.deps);
    expect(s.store.approve).not.toHaveBeenCalled();
    expect(s.baseFinalize).not.toHaveBeenCalled();
    expect(s.replaceOriginal).toHaveBeenCalledWith(expect.anything(), "⚠️ Could not record the decision");
  });

  it("locked recipient: closes the row via approveLocked, no approve, no base finalize, own card text", async () => {
    const s = setup();
    s.deps.sendLocked = (to) => to === "fake.dev.one@example.test";
    await finalizeApproval(click, wrapped({ approved: true, authorized: true }), s.deps);
    expect(s.store.approveLocked).toHaveBeenCalledWith({
      outreachId: 7,
      draftHash: "hash",
      decidedBy: "U0APPROVER",
      to: "fake.dev.one@example.test",
      login: "fake-dev-one",
    });
    expect(s.store.approve).not.toHaveBeenCalled();
    expect(s.baseFinalize).not.toHaveBeenCalled();
    expect(s.replaceOriginal).toHaveBeenCalledWith(expect.anything(), "Approved by <@U0APPROVER>, but sending is locked: nothing was sent.");
  });

  it("a card rendered locked stays locked even if the lock was lifted before the click", async () => {
    const card = renderApprovalCard({ input }, { button }, { sendLocked: () => true });
    const approveOutput = buttonsOf(card)[0]!.output as object;
    const s = setup();
    s.deps.sendLocked = () => false;
    const resolution = wrapResolution({ toolCallId: "t1", output: approveOutput }, "U0APPROVER", new Set(["U0APPROVER"]), () => false)!;
    expect((resolution.output as unknown as { whatToSay: string }).whatToSay).toBe(
      "Approved, but sending is locked; the record is closed and nothing was sent. Say that nothing was sent.",
    );
    await finalizeApproval(click, resolution, s.deps);
    expect(s.store.approveLocked).toHaveBeenCalledTimes(1);
    expect(s.store.approve).not.toHaveBeenCalled();
    expect(s.baseFinalize).not.toHaveBeenCalled();
  });

  it("locked recipient: deny and never-show are unaffected, and a failed locked close shows the warning", async () => {
    const s = setup({ approveLocked: async () => ({ ok: false, reason: "draft_changed" }) });
    s.deps.sendLocked = () => true;
    await finalizeApproval(click, wrapped({ approved: false, authorized: true }), s.deps);
    expect(s.store.deny).toHaveBeenCalledTimes(1);
    expect(s.baseFinalize).toHaveBeenCalledTimes(1);
    const t = setup({ approveLocked: async () => ({ ok: false, reason: "draft_changed" }) });
    t.deps.sendLocked = () => true;
    await finalizeApproval(click, wrapped({ approved: true, authorized: true }), t.deps);
    expect(t.replaceOriginal).toHaveBeenCalledWith(expect.anything(), "⚠️ Not approved: draft changed or expired");
    expect(t.baseFinalize).not.toHaveBeenCalled();
  });

  it("malformed output: no DB call, notice, no base finalize", async () => {
    const s = setup();
    await finalizeApproval(click, { output: { approved: true } }, s.deps);
    expect(s.store.approve).not.toHaveBeenCalled();
    expect(s.baseFinalize).not.toHaveBeenCalled();
    expect(s.replaceOriginal).toHaveBeenCalledWith(expect.anything(), "⚠️ Could not record the decision");
  });
});

describe("makeReplaceOriginal", () => {
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: "card" } },
    { type: "actions", elements: [] },
  ];

  it("posts replace_original to a Slack response_url without the actions block", async () => {
    const f = vi.fn(async () => new Response("ok"));
    await makeReplaceOriginal(f as unknown as typeof fetch)(
      { responseUrl: "https://hooks.slack.com/actions/T/1/x", blocks },
      "⚠️ note",
    );
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/actions/T/1/x");
    const body = JSON.parse(String(init.body));
    expect(body.replace_original).toBe(true);
    expect(body.text).toBe("⚠️ note");
    expect(body.blocks.map((b: { type: string }) => b.type)).toEqual(["section", "context"]);
  });

  it("refuses non-Slack hosts and missing urls", async () => {
    const f = vi.fn(async () => new Response("ok"));
    const replace = makeReplaceOriginal(f as unknown as typeof fetch);
    await replace({ responseUrl: "https://evil.example.test/x", blocks }, "n");
    await replace({ blocks }, "n");
    expect(f).not.toHaveBeenCalled();
  });

  it("swallows fetch failures", async () => {
    const f = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      makeReplaceOriginal(f as unknown as typeof fetch)({ responseUrl: "https://hooks.slack.com/x" }, "n"),
    ).resolves.toBeUndefined();
  });
});
