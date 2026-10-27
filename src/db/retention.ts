import type { Db } from "./client.js";

export const PENDING_TTL_HOURS = 24;
export const RETENTION_DAYS = 90;

export async function expireStalePending(db: Db): Promise<number> {
  const rows = await db`
    UPDATE outreach SET status = 'expired'
    WHERE status = 'pending_approval'
      AND created_at <= now() - make_interval(hours => ${PENDING_TTL_HOURS})
    RETURNING id
  `;
  return rows.length;
}

export async function scrubOldOutreach(db: Db, days: number = RETENTION_DAYS): Promise<number> {
  const rows = await db`
    UPDATE outreach
    SET contact_value = NULL, subject = NULL, body = NULL, error = NULL
    WHERE created_at < now() - make_interval(days => ${days})
      AND (contact_value IS NOT NULL OR subject IS NOT NULL OR body IS NOT NULL OR error IS NOT NULL)
    RETURNING id
  `;
  return rows.length;
}

export type RetentionCounts = { expired: number; scrubbed: number };

export async function runRetention(db: Db): Promise<RetentionCounts> {
  const expired = await expireStalePending(db);
  const scrubbed = await scrubOldOutreach(db);
  return { expired, scrubbed };
}
