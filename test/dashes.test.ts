import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webhooks } from "@trigger.dev/sdk";
import { appMentions, webhookSource } from "@trigger.dev/slack";
import type { Db } from "../src/db/client.js";
import type { Candidate } from "../src/github/sourcing.js";
import { demoConfigFromEnv } from "../src/outreach/demo.js";
import { draftHash } from "../src/outreach/hash.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { renderApprovalCard, type ButtonFactory } from "../src/slack/approval.js";
import { renderCandidateCard } from "../src/slack/candidateCard.js";
import { scoutSlack } from "../src/slack/connector.js";
import { createTurnStore } from "../src/slack/turn.js";
import { stripDashes } from "../src/text.js";
import type { ToolDeps } from "../src/tools/deps.js";
import { makePrepareOutreach } from "../src/tools/prepareOutreach.js";
import { fakeClient } from "./fakeGithub.js";
import { getRow, makeSearch, setupSchema, type TestDb } from "./helpers.js";

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const ANY = new RegExp("[" + String.fromCharCode(0x2013) + String.fromCharCode(0x2014) + "]");

describe("stripDashes", () => {
  it.each([
    [`Scout ${EM} I help`, "Scout, I help"],
    [`Scout${EM}I help`, "Scout, I help"],
    [`Hello ${EN} world`, "Hello, world"],
    [`2020${EN}2024`, "2020-2024"],
    [`2020${EM}2024`, "2020-2024"],
    [`Scout${EN}Tool`, "Scout-Tool"],
    [`Wait.${EM} Then go`, "Wait. Then go"],
    [`Wait, ${EM} then go`, "Wait, then go"],
    [`${EM} leading`, "leading"],
    [`trailing ${EM}`, "trailing"],
    [`a ${EM}${EM} b`, "a, b"],
    [`line one ${EM} two\nline ${EN} three`, "line one, two\nline, three"],
    ["no dashes - here, plain hyphen stays", "no dashes - here, plain hyphen stays"],
    ["  indented\n    list item stays", "  indented\n    list item stays"],
    ["", ""],
  ])("%j -> %j", (input, expected) => {
    expect(stripDashes(input)).toBe(expected);
    expect(ANY.test(stripDashes(input))).toBe(false);
  });

  it("leaves text without dashes byte for byte unchanged", () => {
    const text = "Hi  there,\n\n  two spaces   kept.  *bold* `code`";
    expect(stripDashes(text)).toBe(text);
  });
});

describe("system prompt", () => {
  it("states the no-dash rule for replies and drafts, without using a dash itself", () => {
    for (const sendEnabled of [true, false]) {
      const p = buildSystemPrompt({ sendEnabled });
      expect(p).toMatch(/never use em dashes or en dashes/);
      expect(p).toMatch(/Slack replies or in email drafts/);
      expect(ANY.test(p)).toBe(false);
    }
  });
});

describe("prompt rules", () => {
  const p = buildSystemPrompt({ sendEnabled: true });
  it("runs the search once, mirrors the withheld count, uses the code-built next step and forbids URLs and addresses", () => {
    expect(p).toMatch(/Run searchGitHub once per request/);
    expect(p).toMatch(/say in one sentence how many other real candidates were withheld because they did not consent to appear/);
    expect(p).toMatch(/do not widen, repeat or apologise/);
    expect(p).toContain("your reply is exactly: the summary line from postCandidateCard, then in demo mode the withheld sentence from the search note, then the nextStep line, each verbatim");
    expect(p).toContain("Write nothing before or between tool calls. Compose your reply once, after the last tool result.");
    expect(p).toContain("do what the whatToSay text in the result says and nothing more");
    expect(p).toContain("Never mention outreach ids, revisions or internal states in replies");
    expect(p).not.toContain("Say 'draft outreach to");
    expect(p).toMatch(/single request already asks for outreach, you may go straight to the draft/);
    expect(p).toContain("Never put URLs in Slack replies; the cards carry the links.");
    expect(p).toContain('Never write email addresses or URLs in replies; say "the address on the approval card".');
  });

  it("has the tone rules and the no-signature rule for drafts", () => {
    expect(p).toContain("address the person by first name when known");
    expect(p).toContain("one low-pressure ask (a 20-minute call)");
    expect(p).toContain("under 110 words, plain text, no superlatives, no exclamation marks");
    expect(p).toContain("no subject-line bait");
    expect(p).toContain("End the body with 'Thanks,' on its own line. Never write a name, title or company in a sign-off; a signature line is appended automatically when one is configured.");
    expect(p).not.toContain("one is appended automatically");
  });
});

describe("source hygiene", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }

  it("has no em or en dashes anywhere in src", () => {
    const bad = walk("src").filter((f) => ANY.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});

describe("slack outbound", () => {
  const endpoint = webhooks.endpoint.define({ id: "slack-dashes-test", source: webhookSource() });
  const connector = scoutSlack({
    id: "slack",
    endpoint,
    token: () => "xoxb-test-token",
    startOn: appMentions(),
    approvers: () => new Set(["U0APPROVER"]),
  });
  const reply = (text: string) => ({ text, message: {} as never, final: true, stopped: false });

  it("strips dashes from outgoing reply text", () => {
    expect(connector.outbound?.(reply(`Scout ${EM} I help with hiring ${EN} ask away`))).toEqual({
      text: "Scout, I help with hiring, ask away",
    });
  });

  it("passes plain text through and posts nothing for an empty reply", () => {
    expect(connector.outbound?.(reply("All good."))).toEqual({ text: "All good." });
    expect(connector.outbound?.(reply(""))).toBeNull();
  });
});

describe("cards", () => {
  const button: ButtonFactory = (o) => o;
  const input = {
    outreachId: 1,
    candidate: { login: "fake-dev-one", name: `Fake ${EM} One`, summary: `Builds tools ${EN} and more` },
    evidence: [{ label: `repo#1 Fix ${EM} thing`, url: "https://github.com/a/b/pull/1" }],
    contact: { value: "fake@example.test", provenance: "email published on GitHub profile" },
    subject: "Plain subject",
    body: "Plain body text.",
  };

  it("approval card display fields carry no dashes", () => {
    const card = renderApprovalCard({ input }, { button });
    expect(ANY.test(JSON.stringify(card))).toBe(false);
  });

  it("candidate card display fields carry no dashes", () => {
    const c: Candidate = {
      githubUserId: 1,
      login: "fake-dev-one",
      name: `Fake ${EM} One`,
      bio: `Bio ${EN} text`,
      company: null,
      location: null,
      profileUrl: "https://github.com/fake-dev-one",
      contributedTo: [`org${EM}x/repo`],
      evidence: [{ kind: "merged_pr", label: `PR ${EM} title`, url: "https://github.com/a/b/pull/1" }],
      contactRoutes: [],
    };
    expect(ANY.test(JSON.stringify(renderCandidateCard(c)))).toBe(false);
  });
});

describe("prepareOutreach normalisation", () => {
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

  const candidate: Candidate = {
    githubUserId: 9901,
    login: "fake-dash-dev",
    name: null,
    bio: null,
    company: null,
    location: null,
    profileUrl: "https://github.com/fake-dash-dev",
    contributedTo: [],
    evidence: [],
    contactRoutes: [{ channel: "email", value: "fake.dash@example.test", provenance: "email published on GitHub profile" }],
  };

  it("stores and returns dash-free text, and the card hash equals the stored draft_hash", async () => {
    const turn = createTurnStore();
    turn.setThread({ channel: "C0FAKE", threadTs: "1.1", userId: "U0ASKER" });
    turn.setSearch(sid, "q", [candidate]);
    const deps: ToolDeps = {
      db: () => db,
      github: () => fakeClient({}),
      demo: () => demoConfigFromEnv({ SEND_MODE: "open" }),
      turn,
      post: async () => ({ ts: "1" }),
      sendConfig: () => {
        throw new Error("unused");
      },
      send: async () => {
        throw new Error("unused");
      },
      now: () => new Date(),
      signature: () => undefined,
    };
    const exec = makePrepareOutreach(deps).execute as unknown as (i: unknown, o: unknown) => Promise<Record<string, unknown>>;
    const r = await exec(
      {
        login: "fake-dash-dev",
        contactValue: "fake.dash@example.test",
        subject: `Your queue work ${EM} a quick note`,
        body: `Hi there ${EM} we saw your queue worker${EN}really nice. Open to a chat in 2026${EN}27?\n\nThanks ${EM} the fake team`,
      },
      { toolCallId: "t", messages: [] },
    );
    expect(ANY.test(String(r.subject))).toBe(false);
    expect(ANY.test(String(r.body))).toBe(false);
    expect(r.subject).toBe("Your queue work, a quick note");
    expect(String(r.body)).toContain("Hi there, we saw your queue worker-really nice.");
    expect(String(r.body)).toContain("2026-27");
    expect(String(r.body)).toContain("Thanks, the fake team");

    const row = await getRow(db, r.outreachId as number);
    expect(row.subject).toBe(r.subject);
    expect(row.body).toBe(r.body);
    expect(ANY.test(`${row.subject}${row.body}`)).toBe(false);
    expect(row.draft_hash).toBe(draftHash(row.subject!, row.body!));

    const card = renderApprovalCard(
      {
        input: {
          outreachId: r.outreachId,
          candidate: { login: r.login },
          evidence: [],
          contact: r.contact,
          subject: r.subject,
          body: r.body,
        },
      },
      { button: (o) => o },
    );
    const actions = card.blocks.find((b) => (b as { type: string }).type === "actions") as { elements: { output: { h: string } }[] };
    expect(actions.elements[0]!.output.h).toBe(row.draft_hash);
  });
});
