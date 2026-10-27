import { randomBytes } from "node:crypto";
import { createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { prepareOutreach, type OutreachRow, type PrepareInput } from "../src/outreach/state.js";

const BASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://scout:scout@localhost:54329/scout";

export type TestDb = { db: Db; drop: () => Promise<void> };

export async function setupSchema(): Promise<TestDb> {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = createDb(BASE_URL, 1);
  await admin.unsafe("SET client_min_messages = warning");
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const db = createDb(BASE_URL, 3, { search_path: schema });
  await migrate(db);
  return {
    db,
    drop: async () => {
      await db.end({ timeout: 5 });
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end({ timeout: 5 });
    },
  };
}

export async function makeSearch(db: Db): Promise<number> {
  const [row] = await db<{ id: number }[]>`
    INSERT INTO searches (slack_channel_id, slack_thread_ts, requested_by, query)
    VALUES ('C0FAKE', '1700000000.000100', 'U0FAKE', 'fake query')
    RETURNING id
  `;
  return row!.id;
}

export function draftInput(searchId: number, over: Partial<PrepareInput> = {}): PrepareInput {
  return {
    searchId,
    githubUserId: 1001,
    githubLogin: "fake-dev-one",
    contactValue: "fake.dev.one@example.test",
    contactProvenance: "email published on GitHub profile",
    subject: "Hello from the fake team",
    body: "Hi Fake Dev, this is a fixture message.",
    ...over,
  };
}

export async function makePending(
  db: Db,
  searchId: number,
  over: Partial<PrepareInput> = {},
): Promise<{ id: number; hash: string; to: string; login: string }> {
  const input = draftInput(searchId, over);
  const r = await prepareOutreach(db, input);
  if (!r.ok) throw new Error(`fixture prepare refused: ${r.reason}`);
  return { id: r.outreachId, hash: r.draftHash, to: input.contactValue, login: input.githubLogin };
}

export async function getRow(db: Db, id: number): Promise<OutreachRow> {
  const [row] = await db<OutreachRow[]>`SELECT * FROM outreach WHERE id = ${id}`;
  return row!;
}
