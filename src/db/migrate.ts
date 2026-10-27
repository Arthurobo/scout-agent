import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, getDb, type Db } from "./client.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(db: Db, dir: string = migrationsDir): Promise<string[]> {
  await db`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  for (const name of files) {
    const sqlText = readFileSync(join(dir, name), "utf8");
    const didApply = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(727001)`;
      const done = await tx`SELECT 1 FROM schema_migrations WHERE name = ${name}`;
      if (done.length > 0) return false;
      await tx.unsafe(sqlText);
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
      return true;
    });
    if (didApply) applied.push(name);
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const applied = await migrate(getDb());
    console.log(applied.length > 0 ? `applied: ${applied.join(", ")}` : "up to date");
  } finally {
    await closeDb();
  }
}
