CREATE TABLE searches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slack_channel_id TEXT NOT NULL,
  slack_thread_ts TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  query TEXT NOT NULL,
  trigger_run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX searches_thread_idx ON searches (slack_channel_id, slack_thread_ts);

CREATE TABLE outreach (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  search_id BIGINT NOT NULL REFERENCES searches (id) ON DELETE CASCADE,
  github_user_id BIGINT NOT NULL,
  github_login TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  contact_value TEXT NOT NULL,
  contact_provenance TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  draft_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN (
      'pending_approval', 'approved', 'sending', 'send_unknown',
      'sent', 'denied', 'expired', 'superseded', 'failed'
    )),
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  provider_message_id TEXT,
  sent_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX outreach_search_idx ON outreach (search_id);
CREATE INDEX outreach_user_search_idx ON outreach (github_user_id, search_id);
CREATE INDEX outreach_status_created_idx ON outreach (status, created_at);

CREATE UNIQUE INDEX outreach_one_live_per_user
  ON outreach (github_user_id)
  WHERE status IN ('approved', 'sending', 'send_unknown', 'sent');

CREATE TABLE suppressed_contacts (
  github_user_id BIGINT PRIMARY KEY,
  github_login TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('never_show_clicked', 'opted_out', 'manual')),
  added_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
