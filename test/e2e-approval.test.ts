import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client.js";
import type { Candidate } from "../src/github/sourcing.js";
import { demoConfigFromEnv } from "../src/outreach/demo.js";
import { draftHash } from "../src/outreach/hash.js";
import { claimSend } from "../src/outreach/state.js";
import { renderApprovalCard, wrapResolution, type ButtonFactory } from "../src/slack/approval.js";
import { dbDecisionStore, finalizeApproval } from "../src/slack/finalize.js";
import { createTurnStore } from "../src/slack/turn.js";
import type { ToolDeps } from "../src/tools/deps.js";
import { makePrepareOutreach } from "../src/tools/prepareOutreach.js";
import { fakeClient } from "./fakeGithub.js";
import { getRow, makeSearch, setupSchema, type TestDb } from "./helpers.js";

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

const candidate = (id: number, login: string): Candidate => ({
  githubUserId: id,
  login,
  name: null,
  bio: null,
  company: null,
  location: null,
  profileUrl: `https://github.com/${login}`,
  contributedTo: [],
  evidence: [],
  contactRoutes: [{ channel: "email", value: `${login}@example.test`, provenance: "email published on GitHub profile" }],
});

function deps(turn = createTurnStore()): ToolDeps {
  turn.setThread({ channel: "C0FAKE", threadTs: "1.1", userId: "U0ASKER" });
  return {
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
}

const capture: ButtonFactory = (o) => o;
const prepare = (d: ToolDeps, input: unknown) =>
  (makePrepareOutreach(d).execute as unknown as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {
    toolCallId: "t0",
    messages: [],
  });

type Button = { text: string; output: Record<string, unknown> };
function buttons(card: { blocks: unknown[] }): Button[] {
  const actions = card.blocks.find((b) => (b as { type: string }).type === "actions") as { elements: Button[] };
  return actions.elements;
}

async function chain(login: string, id: number, mutate: (body: string) => string = (b) => b) {
  const d = deps();
  d.turn.setSearch(sid, "q", [candidate(id, login)]);
  const prepared = await prepare(d, {
    login,
    contactValue: `${login}@example.test`,
    subject: "A note about fake infra",
    body: "Hi there, we saw your work on the fake queue worker. Interested in chatting?",
  });
  const outreachId = prepared.outreachId as number;
  const card = renderApprovalCard(
    {
      input: {
        outreachId,
        candidate: { login: prepared.login },
        evidence: [],
        contact: prepared.contact,
        subject: prepared.subject,
        body: mutate(prepared.body as string),
      },
    },
    { button: capture },
  );
  const approve = buttons(card)[0]!;
  const approvers = new Set(["U0APPROVER"]);
  const resolution = wrapResolution({ toolCallId: "call_1", output: approve.output }, "U0APPROVER", approvers);
  const replaceOriginal = vi.fn(async () => {});
  const baseFinalize = vi.fn(async () => {});
  await finalizeApproval({ userId: "U0APPROVER" }, resolution!, {
    approvers,
    store: dbDecisionStore(() => db),
    replaceOriginal,
    baseFinalize,
  });
  return { prepared, approve, outreachId, replaceOriginal, baseFinalize };
}

describe("card -> click -> database -> send claim", () => {
  it("the hash on the card equals the stored draft_hash and the approval is recorded and claimable", async () => {
    const r = await chain("fake-e2e-one", 8101);
    const row = await getRow(db, r.outreachId);
    expect(r.approve.output.h).toBe(row.draft_hash);
    expect(row.draft_hash).toBe(draftHash(row.subject!, row.body!));
    expect(row.body).toContain("Not interested? Reply 'no thanks'");
    expect(r.baseFinalize).toHaveBeenCalledTimes(1);
    expect(r.replaceOriginal).not.toHaveBeenCalled();
    expect(row.status).toBe("approved");
    expect(row.decided_by).toBe("U0APPROVER");
    const claimed = await claimSend(db, r.outreachId);
    expect(claimed?.status).toBe("sending");
    expect(await claimSend(db, r.outreachId)).toBeNull();
  });

  it("a one-character change to the body on the card is refused as draft changed", async () => {
    const r = await chain("fake-e2e-two", 8102, (b) => b.replace("Hi there", "Hi there!"));
    const row = await getRow(db, r.outreachId);
    expect(r.approve.output.h).not.toBe(row.draft_hash);
    expect(r.baseFinalize).not.toHaveBeenCalled();
    expect(r.replaceOriginal).toHaveBeenCalledWith(expect.anything(), "⚠️ Not approved: draft changed or expired");
    expect(row.status).toBe("pending_approval");
    expect(await claimSend(db, r.outreachId)).toBeNull();
  });

  it("the Deny and Never show outputs from the same card also reach the database", async () => {
    const d = deps();
    d.turn.setSearch(sid, "q", [candidate(8103, "fake-e2e-three")]);
    const prepared = await prepare(d, {
      login: "fake-e2e-three",
      contactValue: "fake-e2e-three@example.test",
      subject: "A note about fake infra",
      body: "Hi there, we saw your work on the fake queue worker. Interested in chatting?",
    });
    const card = renderApprovalCard(
      {
        input: {
          outreachId: prepared.outreachId,
          candidate: { login: prepared.login },
          evidence: [],
          contact: prepared.contact,
          subject: prepared.subject,
          body: prepared.body,
        },
      },
      { button: capture },
    );
    const never = buttons(card)[2]!;
    const approvers = new Set(["U0APPROVER"]);
    const baseFinalize = vi.fn(async () => {});
    await finalizeApproval(
      { userId: "U0APPROVER" },
      wrapResolution({ toolCallId: "c", output: never.output }, "U0APPROVER", approvers)!,
      { approvers, store: dbDecisionStore(() => db), replaceOriginal: vi.fn(async () => {}), baseFinalize },
    );
    expect(baseFinalize).toHaveBeenCalledTimes(1);
    expect((await getRow(db, prepared.outreachId as number)).status).toBe("denied");
    const rows = await db`SELECT 1 FROM suppressed_contacts WHERE github_user_id = 8103`;
    expect(rows).toHaveLength(1);
  });
});
