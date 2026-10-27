import type { Db } from "./client.js";

export type SearchInput = {
  slackChannelId: string;
  slackThreadTs: string;
  requestedBy: string;
  query: string;
  triggerRunId?: string;
};

export async function insertSearch(db: Db, input: SearchInput): Promise<number> {
  const [row] = await db<{ id: number }[]>`
    INSERT INTO searches (slack_channel_id, slack_thread_ts, requested_by, query, trigger_run_id)
    VALUES (${input.slackChannelId}, ${input.slackThreadTs}, ${input.requestedBy}, ${input.query},
      ${input.triggerRunId ?? null})
    RETURNING id
  `;
  return row!.id;
}

export type BlockedIds = { suppressed: Set<number>; live: Set<number> };

export async function loadBlockedIds(db: Db, githubUserIds: number[]): Promise<BlockedIds> {
  if (githubUserIds.length === 0) return { suppressed: new Set(), live: new Set() };
  const suppressed = await db<{ github_user_id: number }[]>`
    SELECT github_user_id FROM suppressed_contacts WHERE github_user_id IN ${db(githubUserIds)}
  `;
  const live = await db<{ github_user_id: number }[]>`
    SELECT DISTINCT github_user_id FROM outreach
    WHERE github_user_id IN ${db(githubUserIds)}
      AND status IN ('approved', 'sending', 'send_unknown', 'sent')
  `;
  return {
    suppressed: new Set(suppressed.map((r) => r.github_user_id)),
    live: new Set(live.map((r) => r.github_user_id)),
  };
}

export async function suppressContact(
  db: Db,
  input: { githubUserId: number; githubLogin: string; addedBy: string },
): Promise<void> {
  await db`
    INSERT INTO suppressed_contacts (github_user_id, github_login, reason, added_by)
    VALUES (${input.githubUserId}, ${input.githubLogin}, 'never_show_clicked', ${input.addedBy})
    ON CONFLICT (github_user_id) DO NOTHING
  `;
}
