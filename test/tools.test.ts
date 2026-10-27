import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client.js";
import { GitHubRateLimitError } from "../src/github/client.js";
import type { Candidate } from "../src/github/sourcing.js";
import { demoConfigFromEnv } from "../src/outreach/demo.js";
import { recordSuppression } from "../src/outreach/state.js";
import { OPT_OUT_LINE } from "../src/outreach/template.js";
import { draftHash } from "../src/outreach/hash.js";
import { actionSchema, handleAction } from "../src/slack/actions.js";
import { renderCandidateCard } from "../src/slack/candidateCard.js";
import { NoThreadError } from "../src/slack/post.js";
import { createTurnStore } from "../src/slack/turn.js";
import type { ToolDeps } from "../src/tools/deps.js";
import { makePostCandidateCard } from "../src/tools/postCandidateCard.js";
import { makePrepareOutreach } from "../src/tools/prepareOutreach.js";
import { makeSearchGitHub } from "../src/tools/searchGitHub.js";
import { contributor, fakeClient, mergedPr, profile } from "./fakeGithub.js";
import { makeSearch, setupSchema, type TestDb } from "./helpers.js";

let t: TestDb;
let db: Db;
let sid: number;

beforeAll(async () => {
  t = await setupSchema();
  db = t.db;
  sid = await makeSearch(db);
});
afterAll(async () => {
  await t.drop();
});

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  githubUserId: 3001,
  login: "fake-dev-one",
  name: "Fake One",
  bio: "Builds <b>fake</b> tools",
  company: null,
  location: null,
  profileUrl: "https://github.com/fake-dev-one",
  contributedTo: ["seed/alpha"],
  evidence: [{ kind: "merged_pr", label: "seed/alpha#1 Fix | thing", url: "https://github.com/seed/alpha/pull/1" }],
  contactRoutes: [
    { channel: "email", value: "fake.one@example.test", provenance: "email published on GitHub profile" },
    { channel: "twitter", value: "@fake_one", provenance: "X/Twitter handle published on GitHub profile" },
  ],
  ...over,
});

function makeDeps(over: Partial<ToolDeps> = {}) {
  const turn = createTurnStore();
  turn.setThread({ channel: "C0FAKE", threadTs: "1700000000.000100", userId: "U0ASKER" });
  turn.setRunId("run_fake");
  const posts: { text: string; blocks?: unknown[] }[] = [];
  const deps: ToolDeps = {
    db: () => db,
    github: () => fakeClient({}),
    demo: () => demoConfigFromEnv({ SEND_MODE: "open" }),
    turn,
    post: async (m) => {
      posts.push(m);
      return { ts: "1" };
    },
    sendConfig: () => {
      throw new Error("not used");
    },
    send: async () => {
      throw new Error("not used");
    },
    now: () => new Date("2026-10-27T09:30:00Z"),
    signature: () => undefined,
    ...over,
  };
  return { deps, turn, posts };
}

const run = <T extends { execute?: unknown }>(tool: T, input: unknown) =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {
    toolCallId: "t1",
    messages: [],
  });

const draft = {
  login: "fake-dev-one",
  contactValue: "fake.one@example.test",
  subject: "A note about fake infra",
  body: "Hi Fake One, we saw your work on the fake queue worker. Interested in chatting?",
};

describe("prepareOutreach tool", () => {
  it("stores a draft for a known candidate and returns id, hash, subject and body", async () => {
    const { deps, turn } = makeDeps();
    turn.setSearch(sid, "q", [candidate()]);
    const r = await run(makePrepareOutreach(deps), draft);
    expect(r).toMatchObject({ subject: draft.subject, body: `${draft.body}\n\n${OPT_OUT_LINE}`, revision: 1 });
    expect(typeof r.outreachId).toBe("number");
    expect(r.draftHash).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await db`SELECT github_login, contact_value, contact_provenance, subject, body, draft_hash, status FROM outreach WHERE id = ${r.outreachId as number}`;
    expect(r.login).toBe(row?.github_login);
    expect(r.contact).toEqual({ value: row?.contact_value, provenance: row?.contact_provenance });
    expect(r.subject).toBe(row?.subject);
    expect(r.body).toBe(row?.body);
    expect(r.draftHash).toBe(row?.draft_hash);
    expect(r.draftHash).toBe(draftHash(row?.subject, row?.body));
    expect(row).toMatchObject({
      contact_value: "fake.one@example.test",
      contact_provenance: "email published on GitHub profile",
      status: "pending_approval",
    });
  });

  it("refuses an unknown candidate and an address that is not a published email route", async () => {
    const { deps, turn } = makeDeps();
    turn.setSearch(sid, "q", [candidate()]);
    const tool = makePrepareOutreach(deps);
    expect(await run(tool, { ...draft, login: "someone-else" })).toMatchObject({ refused: true });
    expect(await run(tool, { ...draft, contactValue: "stranger@example.test" })).toMatchObject({ refused: true });
    expect(await run(tool, { ...draft, contactValue: "@fake_one" })).toMatchObject({ refused: true });
  });

  it("drafts for a recipient outside the allowlist and flags sendLocked; allowed recipients are not flagged", async () => {
    const locked = demoConfigFromEnv({ SEND_ALLOWED_RECIPIENTS: "owner@example.test" });
    const a = makeDeps({ demo: () => locked });
    a.turn.setSearch(sid, "q", [candidate({ githubUserId: 3040, login: "fake-locked" })]);
    const r = await run(makePrepareOutreach(a.deps), { ...draft, login: "fake-locked" });
    expect(r.refused).toBeUndefined();
    expect(r.sendLocked).toBe(true);
    expect(typeof r.outreachId).toBe("number");

    const allowed = demoConfigFromEnv({ SEND_ALLOWED_RECIPIENTS: "fake.one@example.test" });
    const b = makeDeps({ demo: () => allowed });
    b.turn.setSearch(sid, "q", [candidate({ githubUserId: 3041, login: "fake-allowed" })]);
    expect((await run(makePrepareOutreach(b.deps), { ...draft, login: "fake-allowed" })).sendLocked).toBe(false);
  });

  it("refuses a suppressed person and a person who was already approved", async () => {
    const { deps, turn } = makeDeps();
    turn.setSearch(sid, "q", [candidate({ githubUserId: 3002, login: "fake-suppressed" })]);
    const tool = makePrepareOutreach(deps);
    const own = { ...draft, login: "fake-suppressed" };
    const first = await run(tool, own);
    expect(typeof first.outreachId).toBe("number");
    await recordSuppression(db, {
      outreachId: first.outreachId as number,
      draftHash: "x",
      decidedBy: "U0APPROVER",
      to: own.contactValue,
      login: "fake-suppressed",
    });
    expect(await run(tool, own)).toMatchObject({ refused: true, reason: expect.stringMatching(/do-not-contact/) });

    turn.setSearch(sid, "q", [candidate({ githubUserId: 3003, login: "fake-live" })]);
    const second = await run(tool, { ...draft, login: "fake-live" });
    await db`UPDATE outreach SET status = 'approved' WHERE id = ${second.outreachId as number}`;
    expect(await run(tool, { ...draft, login: "fake-live" })).toMatchObject({
      refused: true,
      reason: expect.stringMatching(/already/),
    });
  });

  it("appends the signature before the opt-out line, once, inside the stored body and hash", async () => {
    const { deps, turn } = makeDeps({ signature: () => "Fake Founder, founder, Fake Co" });
    turn.setSearch(sid, "q", [candidate({ githubUserId: 3030, login: "fake-sig" })]);
    const tool = makePrepareOutreach(deps);
    const r = await run(tool, { ...draft, login: "fake-sig" });
    expect(r.body).toBe(`${draft.body}\n\nFake Founder, founder, Fake Co\n\n${OPT_OUT_LINE}`);
    const [row] = await db`SELECT body, draft_hash FROM outreach WHERE id = ${r.outreachId as number}`;
    expect(row?.body).toBe(r.body);
    expect(row?.draft_hash).toBe(draftHash(r.subject as string, r.body as string));
    turn.setSearch(sid, "q", [candidate({ githubUserId: 3031, login: "fake-sig2" })]);
    const again = await run(tool, { ...draft, login: "fake-sig2", body: `${draft.body}\n\nFake Founder, founder, Fake Co` });
    expect(String(again.body).match(/Fake Founder/g)).toHaveLength(1);
  });

  it("works without a signature", async () => {
    const { deps, turn } = makeDeps();
    turn.setSearch(sid, "q", [candidate({ githubUserId: 3032, login: "fake-nosig" })]);
    const r = await run(makePrepareOutreach(deps), { ...draft, login: "fake-nosig" });
    expect(r.body).toBe(`${draft.body}\n\n${OPT_OUT_LINE}`);
  });

  it("rejects URLs in the subject so the approval card can be built", async () => {
    const { prepareInput } = await import("../src/tools/prepareOutreach.js");
    expect(prepareInput.safeParse({ ...draft, subject: "See https://example.test/x" }).success).toBe(false);
    expect(prepareInput.safeParse({ ...draft, subject: "See www.example.test" }).success).toBe(false);
    expect(prepareInput.safeParse({ ...draft, body: `${draft.body} See https://example.test/x` }).success).toBe(true);
  });

  it("does not append the opt-out line twice", async () => {
    const { deps, turn } = makeDeps();
    turn.setSearch(sid, "q", [candidate({ githubUserId: 3010, login: "fake-optout" })]);
    const body = `${draft.body}\n\n${OPT_OUT_LINE}`;
    const r = await run(makePrepareOutreach(deps), { ...draft, login: "fake-optout", body });
    expect(r.body).toBe(body);
  });

  it("validates subject and body", async () => {
    const { prepareInput } = await import("../src/tools/prepareOutreach.js");
    expect(prepareInput.safeParse({ ...draft, subject: "two\nlines" }).success).toBe(false);
    expect(prepareInput.safeParse({ ...draft, body: "short" }).success).toBe(false);
    expect(prepareInput.safeParse({ ...draft, body: draft.body + " " + "`".repeat(3) + " code" }).success).toBe(false);
    expect(prepareInput.safeParse({ ...draft, subject: "has ``` fence" }).success).toBe(false);
    expect(prepareInput.safeParse(draft).success).toBe(true);
  });

  it("creates a search row when none exists for the turn, and refuses without a thread", async () => {
    const { deps, turn } = makeDeps();
    turn.setThread({ channel: "C0OTHER", threadTs: "9.9", userId: "U0ASKER" });
    turn.setSearch(sid, "q", [candidate({ githubUserId: 3004, login: "fake-fresh" })]);
    const rows = await db`SELECT count(*)::int AS n FROM searches`;
    const r = await run(makePrepareOutreach(deps), { ...draft, login: "fake-fresh" });
    expect(typeof r.outreachId).toBe("number");
    expect(rows[0]?.n).toBeGreaterThan(0);

    const bare = makeDeps();
    bare.turn.setSearch(sid, "q", [candidate()]);
    const noThread = createTurnStore();
    noThread.setSearch(undefined as never, "q", [candidate()]);
    const res = await run(makePrepareOutreach({ ...bare.deps, turn: noThread }), draft);
    expect(res).toMatchObject({ refused: true });
  });
});

describe("searchGitHub and postCandidateCard tools", () => {
  const routes = {
    "/orgs/triggerdotdev/public_members": [],
    "/repos/triggerdotdev/trigger.dev/contributors": [],
    "/repos/Arthurobo/agentflow/contributors": [contributor(49562073, "Arthurobo", 27)],
    "/users/Arthurobo": profile(49562073, "Arthurobo", { email: "owner@example.test" }),
    "/search/issues": { items: [mergedPr("seed/alpha", 1), mergedPr("seed/alpha", 2), mergedPr("seed/alpha", 3)] },
  };

  it("stores a search row, remembers candidates and posts cards rendered from stored data", async () => {
    const { deps, turn, posts } = makeDeps({ github: () => fakeClient(routes) });
    const found = await run(makeSearchGitHub(deps), { query: "agent infra engineers", languages: ["Go"] });
    expect((found.candidates as { login: string }[]).map((c) => c.login)).toEqual(["Arthurobo"]);
    expect(turn.get().searchId).toBeTypeOf("number");
    const [row] = await db`SELECT requested_by, slack_channel_id, trigger_run_id, query FROM searches WHERE id = ${turn.get().searchId!}`;
    expect(row).toMatchObject({ requested_by: "U0ASKER", slack_channel_id: "C0FAKE", trigger_run_id: "run_fake" });

    const posted = await run(makePostCandidateCard(deps), { logins: ["arthurobo", "invented-person"] });
    expect(posted).toEqual({
      posted: ["Arthurobo"],
      alreadyPosted: [],
      unknown: ["invented-person"],
      nextStep: 'Say "draft outreach to Arthurobo" and I will prepare an email for approval.',
      summary: "Posted 1 candidate card: Arthurobo.",
    });
    expect(posts).toHaveLength(1);
  });

  it("returns an error object on a GitHub rate limit and without a thread", async () => {
    const limited = fakeClient({
      "/orgs/triggerdotdev/public_members": new GitHubRateLimitError(403, "GitHub rate limit hit"),
    });
    const { deps } = makeDeps({ github: () => limited });
    expect(await run(makeSearchGitHub(deps), { query: "agent infra engineers" })).toEqual({
      error: "GitHub rate limit hit",
    });
    const empty = makeDeps({ turn: createTurnStore() });
    expect(await run(makeSearchGitHub(empty.deps), { query: "agent infra engineers" })).toMatchObject({
      error: expect.stringMatching(/thread/),
    });
  });

  it("postCandidateCard posts each login once per search and retries after a failed post", async () => {
    const { deps, turn, posts } = makeDeps();
    turn.setSearch(sid, "q", [candidate()]);
    const tool = makePostCandidateCard(deps);
    expect(await run(tool, { logins: ["fake-dev-one"] })).toMatchObject({ posted: ["fake-dev-one"], alreadyPosted: [] });
    expect(await run(tool, { logins: ["FAKE-DEV-ONE"] })).toMatchObject({ posted: [], alreadyPosted: ["fake-dev-one"] });
    expect(posts).toHaveLength(1);

    turn.setSearch(sid, "q2", [candidate()]);
    expect(await run(tool, { logins: ["fake-dev-one"] })).toMatchObject({ posted: ["fake-dev-one"] });
    expect(posts).toHaveLength(2);

    let fail = true;
    const flaky = makeDeps({
      post: async () => {
        if (fail) throw new Error("slack down");
        return { ts: "1" };
      },
    });
    flaky.turn.setSearch(sid, "q", [candidate()]);
    const flakyTool = makePostCandidateCard(flaky.deps);
    await expect(run(flakyTool, { logins: ["fake-dev-one"] })).rejects.toThrow();
    fail = false;
    expect(await run(flakyTool, { logins: ["fake-dev-one"] })).toMatchObject({ posted: ["fake-dev-one"] });
  });

  it("postCandidateCard marks cards in demo mode and searchGitHub reports the withheld count", async () => {
    const demo = demoConfigFromEnv({ DEMO_MODE: "true", DEMO_ALLOWED_LOGINS: "Arthurobo" });
    const withOthers = {
      ...routes,
      "/repos/Arthurobo/agentflow/contributors": [
        contributor(49562073, "Arthurobo", 27),
        contributor(2, "fake-other-one", 5),
        contributor(3, "fake-other-two", 4),
      ],
    };
    const { deps, turn, posts } = makeDeps({ github: () => fakeClient(withOthers), demo: () => demo });
    const found = await run(makeSearchGitHub(deps), { query: "agent infra engineers", languages: ["Go"] });
    expect(found.demoMode).toBe(true);
    expect(found.note).toBe(
      "Demo mode: 2 other real candidates were found and withheld because they did not consent to appear here. Do not widen or repeat the search.",
    );
    expect(turn.get().withheld).toBe(2);
    await run(makePostCandidateCard(deps), { logins: ["Arthurobo"] });
    expect(JSON.stringify(posts[0])).toContain(
      "Demo mode: 2 other real candidates were found and withheld because they did not consent to appear here.",
    );
    expect(turn.get().candidates.size).toBe(1);

    const normal = makeDeps({ github: () => fakeClient(routes) });
    const plain = await run(makeSearchGitHub(normal.deps), { query: "agent infra engineers", languages: ["Go"] });
    expect(plain.demoMode).toBe(false);
    expect(plain).not.toHaveProperty("note");
  });

  it("builds the nextStep line in code for one, several and no posted logins", async () => {
    const { deps, turn } = makeDeps();
    turn.setSearch(sid, "q", [candidate(), candidate({ githubUserId: 3021, login: "fake-two" }), candidate({ githubUserId: 3022, login: "fake-three" })]);
    const tool = makePostCandidateCard(deps);
    expect((await run(tool, { logins: ["fake-dev-one"] })).nextStep).toBe(
      'Say "draft outreach to fake-dev-one" and I will prepare an email for approval.',
    );
    expect((await run(tool, { logins: ["fake-two", "fake-three"] })).nextStep).toBe(
      'Say "draft outreach to fake-two" (or fake-three) and I will prepare an email for approval.',
    );
    expect((await run(tool, { logins: ["fake-two"] })).nextStep).toBe("");
    expect((await run(tool, { logins: ["nobody"] })).nextStep).toBe("");
    turn.setSearch(sid, "q2", [candidate(), candidate({ githubUserId: 3021, login: "fake-two" }), candidate({ githubUserId: 3022, login: "fake-three" })]);
    expect((await run(tool, { logins: ["fake-dev-one", "fake-two", "fake-three"] })).nextStep).toBe(
      'Say "draft outreach to fake-dev-one" (or fake-two, fake-three) and I will prepare an email for approval.',
    );
    expect((await run(tool, { logins: ["fake-dev-one"] })).summary).toBe("");
    turn.setSearch(sid, "q3", [candidate(), candidate({ githubUserId: 3021, login: "fake-two" }), candidate({ githubUserId: 3022, login: "fake-three" })]);
    expect((await run(tool, { logins: ["fake-dev-one", "fake-two", "fake-three"] })).summary).toBe(
      "Posted 3 candidate cards: fake-dev-one, fake-two, fake-three.",
    );
  });

  it("withheld line wording: none, one, many", async () => {
    const { withheldLine } = await import("../src/slack/candidateCard.js");
    expect(withheldLine(0)).toBe("Demo mode: only consenting people appear.");
    expect(withheldLine(1)).toBe("Demo mode: 1 other real candidate was found and withheld because they did not consent to appear here.");
    expect(withheldLine(5)).toBe("Demo mode: 5 other real candidates were found and withheld because they did not consent to appear here.");
  });

  it("postCandidateCard reports a missing thread", async () => {
    const { deps, turn } = makeDeps({
      post: async () => {
        throw new NoThreadError();
      },
    });
    turn.setSearch(sid, "q", [candidate()]);
    expect(await run(makePostCandidateCard(deps), { logins: ["fake-dev-one"] })).toMatchObject({ error: expect.any(String) });
  });
});

describe("candidate card", () => {
  const card = renderCandidateCard(candidate());
  const text = JSON.stringify(card.blocks);

  it("escapes untrusted text and shows provenance", () => {
    expect(text).toContain("Builds &lt;b&gt;fake&lt;/b&gt; tools");
    expect(text).toContain("Published contact routes (GitHub profile): email, X/Twitter");
    expect(text).toContain("https://github.com/seed/alpha/pull/1");
    expect(text).not.toContain("fake.one@example.test");
  });

  it("splits repos the person owns from repos they contribute to", () => {
    const c = candidate({ contributedTo: ["Fake-Dev-One/own-tool", "seed/alpha", "other/lib"] });
    const t = JSON.stringify(renderCandidateCard(c).blocks);
    expect(t).toContain("Maintains: Fake-Dev-One/own-tool");
    expect(t).toContain("Contributes to: seed/alpha, other/lib");
    const none = JSON.stringify(renderCandidateCard(candidate({ contributedTo: ["Fake-Dev-One/own-tool"] })).blocks);
    expect(none).not.toContain("Contributes to");
  });

  it("states when no contact route is published, listing no address", () => {
    const t = JSON.stringify(renderCandidateCard(candidate({ contactRoutes: [] })).blocks);
    expect(t).toContain("No contact route published on GitHub profile");
  });

  it("adds the demo-mode context line only in demo mode", () => {
    expect(JSON.stringify(renderCandidateCard(candidate()).blocks)).not.toContain("Demo mode");
    const demo = renderCandidateCard(candidate(), { demoMode: true });
    expect(JSON.stringify(demo.blocks)).toContain("Demo mode: only consenting people appear.");
    const types = demo.blocks.map((b) => (b as { type: string }).type);
    expect(types[types.length - 1]).toBe("actions");
  });

  it("drops evidence whose URL could break link syntax", () => {
    const bad = renderCandidateCard(
      candidate({
        evidence: [
          { kind: "merged_pr", label: "ok", url: "https://github.com/a/b/pull/1" },
          { kind: "merged_pr", label: "bad", url: "https://evil.example.test|github.com/x" },
        ],
      }),
    );
    const t = JSON.stringify(bad.blocks);
    expect(t).toContain("https://github.com/a/b/pull/1");
    expect(t).not.toContain("evil.example.test");
  });

  it("has one danger button carrying a validated never_show action", () => {
    const actions = card.blocks.find((b) => (b as { type: string }).type === "actions") as {
      elements: { text: { text: string }; style: string; value: string; confirm: unknown }[];
    };
    expect(actions.elements).toHaveLength(1);
    const button = actions.elements[0]!;
    expect(button.style).toBe("danger");
    expect(button.confirm).toBeDefined();
    expect(actionSchema.parse(JSON.parse(button.value))).toEqual({
      type: "never_show",
      githubUserId: 3001,
      login: "fake-dev-one",
    });
  });
});

describe("never_show action", () => {
  const action = { type: "never_show", githubUserId: 3005, login: "fake-dev-one" } as const;

  it("writes the suppression for an approver", async () => {
    const suppress = vi.fn(async () => {});
    const msg = await handleAction(action, { userId: "U0APPROVER" }, { approvers: new Set(["U0APPROVER"]), suppress });
    expect(suppress).toHaveBeenCalledWith({ githubUserId: 3005, githubLogin: "fake-dev-one", addedBy: "U0APPROVER" });
    expect(msg).toMatch(/added to the do-not-contact list/);
  });

  it("changes nothing for a non-approver or an unknown clicker", async () => {
    const suppress = vi.fn(async () => {});
    const deps = { approvers: new Set(["U0APPROVER"]), suppress };
    expect(await handleAction(action, { userId: "U0OTHER" }, deps)).toMatch(/non-approver/);
    expect(await handleAction(action, {}, deps)).toMatch(/non-approver/);
    expect(suppress).not.toHaveBeenCalled();
  });

  it("reports a failed write without leaking the error", async () => {
    const suppress = vi.fn(async () => {
      throw new Error("connection to secret-host refused");
    });
    const msg = await handleAction(action, { userId: "U0APPROVER" }, { approvers: new Set(["U0APPROVER"]), suppress });
    expect(msg).toMatch(/failed/);
    expect(msg).not.toContain("secret-host");
  });

  it("rejects malformed actions", () => {
    expect(actionSchema.safeParse({ type: "never_show", githubUserId: 1, login: "bad login" }).success).toBe(false);
    expect(actionSchema.safeParse({ type: "other" }).success).toBe(false);
  });

  it("really suppresses through the database helper", async () => {
    const { suppressContact } = await import("../src/db/queries.js");
    await handleAction(action, { userId: "U0APPROVER" }, {
      approvers: new Set(["U0APPROVER"]),
      suppress: (i) => suppressContact(db, i),
    });
    const rows = await db`SELECT reason, added_by FROM suppressed_contacts WHERE github_user_id = 3005`;
    expect(rows[0]).toMatchObject({ reason: "never_show_clicked", added_by: "U0APPROVER" });
  });
});

describe("turn store", () => {
  it("keeps candidates within a thread and clears them for a different thread", () => {
    const turn = createTurnStore();
    turn.setThread({ channel: "C1", threadTs: "1" });
    turn.setSearch(5, "q", [candidate()]);
    turn.setThread({ channel: "C1", threadTs: "1", userId: "U9" });
    expect(turn.candidate("FAKE-DEV-ONE")?.login).toBe("fake-dev-one");
    expect(turn.get().searchId).toBe(5);
    turn.setThread({ channel: "C1", threadTs: "2" });
    expect(turn.candidate("fake-dev-one")).toBeUndefined();
    expect(turn.get().searchId).toBeUndefined();
  });
});
