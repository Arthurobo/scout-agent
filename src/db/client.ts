import postgres from "postgres";

export type Db = postgres.Sql;

let pool: Db | undefined;

export function createDb(url: string, max = 3, connection?: Record<string, string>): Db {
  const needsSsl = /[?&]sslmode=(require|verify-ca|verify-full)\b/.test(url);
  return postgres(url, {
    max,
    idle_timeout: 20,
    connect_timeout: 30,
    ssl: needsSsl ? "verify-full" : false,
    connection,
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number | string) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  });
}

export function getDb(): Db {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  pool = createDb(url);
  return pool;
}

export async function closeDb(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = undefined;
  await p.end({ timeout: 5 });
}
