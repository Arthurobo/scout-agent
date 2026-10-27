# Scout

Scout is a Slack hiring agent that finds engineers on GitHub, drafts a short outreach email for each, and sends nothing until a named person clicks Approve in Slack. It runs on Trigger.dev's Webhooks public beta (a hosted, verified endpoint plus a `chat.agent` bound to Slack threads) and explores how far the approval part of an agent can be pushed into code instead of into the prompt. Scout currently runs from `trigger dev` on my machine against the hosted dev endpoint; it has not been deployed to a Trigger.dev production environment.

## Demo flow

1. In #hiring, a teammate mentions Scout: "backend engineers who build AI agent infrastructure (TypeScript or Go)".
2. Scout turns that into search parameters, looks at a curated set of public repos and their contributors, and filters out bots, organizations, Trigger.dev people (a heuristic, see Data and consent), anyone on the do-not-contact list, and anyone already approved or sent.
3. It posts up to three candidate cards with evidence links and the kinds of contact route the person published on their own GitHub profile (the address itself appears only on the approval card).
4. For one candidate it stores a draft, then posts an approval card with the full subject and body (no hyperlinks, so Slack cannot unfurl previews) and three buttons: Approve & send, Deny, Never show this person.
5. The run suspends and costs nothing while it waits. An approver (a Slack user id on the allowlist) clicks Approve.
6. The click is recorded in Postgres, the run resumes, and the send tool emails the stored draft. The thread shows "Sent hh:mm UTC · message id ... (accepted by Scaleway, not yet delivered)".

Demo mode: only consenting people appear. With `DEMO_MODE=true`, only GitHub logins in `DEMO_ALLOWED_LOGINS` can be candidates, so a recording can be limited to consenting people. Cards say how many other real candidates were found and withheld because they did not consent to appear. The login filter runs in sourcing before any profile is fetched or shown ([`src/github/filters.ts`](src/github/filters.ts)). It is code, not prompt. `DEMO_MODE` accepts `true` or `false` (any case, empty means off); any other value makes the first search or send fail instead of silently turning the restriction off.

Sending is locked separately, whether or not demo mode is on: only addresses in `SEND_ALLOWED_RECIPIENTS` can be emailed, unless `SEND_MODE=open`. Anyone with a published email route can be drafted for and shown on an approval card. The allowlist is enforced at send time only: for a recipient who is not on it, the approval card says so, Approve closes the row as failed at click time with "sending locked to the allowlist; nothing was sent" (and the send tool refuses again as a second line), before any provider call, and the person can be drafted again later. Nothing is ever sent to a recipient who is not on the list unless `SEND_MODE=open`. The check is in code ([`src/outreach/demo.ts`](src/outreach/demo.ts), [`src/tools/sendOutreach.ts`](src/tools/sendOutreach.ts)). `SEND_MODE` is `allowlist` (the default when unset) or `open`; an empty allowlist means nothing can be sent.

### Running for real

`DEMO_MODE=false` shows real candidates in your private channel, with contact route kinds only and no addresses on the candidate card. Sends stay locked to `SEND_ALLOWED_RECIPIENTS` until you set `SEND_MODE=open`. The Data and consent section applies to you as the operator. An approval card shows the candidate's published address to the approvers in the thread. Any demo video I publish is recorded in real mode: the people on screen are real GitHub users the search found, shown as Scout's candidate cards show them (public profile fields, links to public work, the kinds of contact route they published, never an address; I do not record a stranger's approval card), and nobody is contacted because sending is locked to my own address. If you appear in a video and would rather not, open an issue on this repository and the clip will be cut. Demo mode exists if you prefer to record only consenting people.

## Architecture

```mermaid
flowchart LR
  S[Slack #hiring] -->|events and button clicks, same URL| E[Trigger.dev hosted endpoint<br/>signature verified]
  E --> A[chat.agent run<br/>one durable session per thread]
  A -->|search, profiles, PRs| G[GitHub API]
  A -->|model calls, data_collection deny| O[OpenRouter]
  A -->|searches, outreach, suppression| P[(Postgres: Docker locally, Neon or any Postgres when deployed)]
  A -->|send approved draft| M[Scaleway TEM]
  A -->|cards and replies| S
```

Why Trigger.dev fits:
- Durable waits with no compute. The approval is a tool with no `execute`; the run suspends until the click and resumes with the click's output as the tool result. Nothing polls and nothing holds a worker for the 24 hours an approval may take (`turnTimeout: "24h"`).
- Verified webhooks. The Slack signature check, the URL handshake and retry dedup happen at the hosted endpoint, so none of that code is mine.
- Run traces. Every turn, tool call and resume is visible in the run view, which is how I check what the agent actually did rather than what it said.

Replies are posted once when a turn ends (`delivery: "final"`), so Scout does not depend on Slack's streaming APIs. Verified on a Free workspace with delivery `final`: mentions, thread follow-ups, cards, approval clicks and replies all worked; streaming was not used; the connector still calls the agent status API, which fails without the agent scopes and is only logged.

Candidate cards and the "Sent" line are posted by Scout directly with link previews turned off. The approval card and Scout's replies are posted by the connector, which cannot set that flag, so they carry no links.

## Approval safety model

The principle: the model can ask for an approval and can ask to send, but only a real Slack click by an authorized person, recorded by code, moves a draft to `approved`, and the send tool only ever sends the stored row.

Guarantees, each with where it lives:

1. Recorded, authorized click. `finalizeInteraction` runs before the run resumes. It checks the clicker's Slack user id against `APPROVER_SLACK_IDS`; for an approver it records the decision with a guarded `UPDATE` (a single transaction for "Never show"), otherwise it changes nothing and replaces the card with "not an approver" (a fresh card follows). [`src/slack/connector.ts`](src/slack/connector.ts), [`src/slack/finalize.ts`](src/slack/finalize.ts), [`src/outreach/state.ts`](src/outreach/state.ts) (`recordApproval`).
2. What the model sees is not what the database trusts. `onInteraction` adds `authorized` and `decidedBy` to the click output so the model can react, but the database write re-derives everything from the stored row and the clicker's id. [`src/slack/approval.ts`](src/slack/approval.ts) (`wrapResolution`).
3. Draft hash. `draft_hash = sha256(subject + "\n" + body)` is stored with the draft and carried in each button. The approval only matches a pending row with the same hash, so a changed draft or an old card cannot approve anything. [`src/outreach/hash.ts`](src/outreach/hash.ts).
4. The card is bound to the stored row. Each button also carries the recipient address and GitHub login shown on the card, and the approval (and the "Never show" suppression) only applies if they match the stored row. A model that shows one address on the card while storing another cannot get the stored one approved.
5. 24 hour expiry, enforced at click time in the same `UPDATE` (`created_at > now() - interval '24 hours'`), since there is no expiry event. `recordApproval`.
6. Never twice. A partial unique index allows only one row per GitHub user in `approved`, `sending`, `send_unknown` or `sent`. [`src/db/migrations/001_init.sql`](src/db/migrations/001_init.sql) (`outreach_one_live_per_user`). A second approval hits the index and the card says "already contacted".
7. Suppression is checked when the draft is stored, when the approval is recorded and when the send is claimed (`prepareOutreach`, `recordApproval`, `claimSend` in `state.ts`), so a "Never show" click also blocks an older pending draft for the same person.
8. Atomic send claim. The send tool first runs `UPDATE ... SET status='sending' WHERE id=$1 AND status='approved'`; zero rows means refuse. Two concurrent or retried calls cannot both send, and there is no provider idempotency key to rely on instead. `claimSend`, used by [`src/tools/sendOutreach.ts`](src/tools/sendOutreach.ts).
9. The email is built from the stored row, never from model text. After the claim, the tool re-checks that the stored subject and body still hash to `draft_hash` and that the recipient is on the send allowlist (or `SEND_MODE=open`), and marks the row `failed` without calling the provider if not. [`src/tools/sendOutreach.ts`](src/tools/sendOutreach.ts).
10. The model cannot choose a recipient. `prepareOutreach` only accepts an address that is one of the email routes published on the candidate's GitHub profile, as found by the search in the same thread. [`src/tools/prepareOutreach.ts`](src/tools/prepareOutreach.ts).
11. Fail closed, visibly. If recording the decision fails or matches nothing, the card is replaced with a warning ("Could not record the decision", "draft changed or expired", "already contacted", "on the do-not-contact list") and the built-in "Approved" collapse is skipped, so a card never says Approved when the database says otherwise. The run still resumes (the SDK treats `finalizeInteraction` as best effort), which is why the send tool refuses any row that is not `approved`.
12. Unknown outcomes are not retried, and a row stuck in `sending` is never re-sent either. After the provider call, `outcomeStatus` in `state.ts` decides the next state from the evidence: a 2xx with a message id is `sent`; a 2xx without one is `send_unknown`, which keeps the never-twice slot until a human reconciles it; otherwise HTTP 408 or 429, or an error type of `quotas_exceeded`, `transient_state` or `locked` (at any status), returns the row to `approved` (nothing was sent, so a re-send needs no new approval); any other 4xx is `failed` and frees the slot; any other 5xx, a timeout or a connection error is `send_unknown`. A 2xx is never turned back into `approved`. Verified live for the 200 path; the non-200 branches are from the documented error shapes, not observed.
13. Untrusted input. GitHub bios and README text are treated as data in the system prompt ([`src/prompt.ts`](src/prompt.ts)), but the prompt is not the control: a hallucinated or injected send call finds no `approved` row and does nothing. All text shown on cards (names, bios, evidence labels, drafts) is escaped so it cannot add Slack mentions or links, and evidence links must be plain `github.com` URLs. Scout's own Slack replies are filtered in code before they are posted: email addresses become "the address on the approval card", URLs are wrapped in backticks so they neither link nor unfurl, and em and en dashes are removed ([`src/text.ts`](src/text.ts)).

Known limits: if the approvers' Slack accounts are compromised, so is this. Approver ids are configuration, not roles. A delivered email cannot be recalled. If a worker dies after claiming a send but before recording the result, the row stays in `sending` until a person reconciles it (see below). Candidates found by a search are held in the run's memory; if the run restarts, Scout asks for a new search before drafting. A candidate card already posted for a search is not posted again in the same run. Code fences (three backticks) are rejected in subjects and bodies so the card shows exactly the text that is sent.

Tests: run `npm run db:up` and then `npm test` (Postgres tests need the Docker database; `TEST_DATABASE_URL` overrides its address). `npm run typecheck` and `npm run lint` cover the rest. The suite covers the card, the authorization truth table and the finalize paths, the unique index and approval guards against real Postgres, the send path with a fake provider, and GitHub sourcing against hand-written fixtures with fake people.

## Data and consent

- No candidate profile store. Scout keeps only: outreach records (the contact route, its provenance and the draft) needed for approvals and for never contacting someone twice; a suppression list; and a record of each search request (Slack channel, thread, requester and the query text). Scout keeps no profile table of its own. The public profile fields a search returns (login, name, bio, company, evidence links, published contact routes) are part of the conversation, so they also live in Trigger.dev's session snapshot and run traces (retention per your Trigger.dev plan) and are sent to the model through OpenRouter.
- Retention: a scheduled task runs daily, starting at 03:00 UTC (Trigger.dev may spread it over the following hour). It marks approvals that stayed pending for more than 24 hours as expired, and after 90 days it removes the contact address, subject, body and any provider error text from outreach rows. The row itself (GitHub id and login, status, draft hash, timestamps, provider message id) stays so never-contact-twice keeps working. The suppression list and the search records are not deleted. This covers Scout's own database only, not Trigger.dev's snapshots and traces. The first scheduled run has not been observed yet. In the dev environment the schedule runs only while `trigger dev` is connected.
- Contact routes: only what a person published on their own GitHub profile (email, X/Twitter handle, website), with the provenance shown. Only an email route can be sent to. No emails are read from commits.
- Trigger.dev people are excluded by a heuristic, not a staff list: public members of the `triggerdotdev` organization, the 25 top contributors of `triggerdotdev/trigger.dev`, and anyone whose bio or company mentions Trigger.dev. It can miss people and can exclude a few community contributors.
- Public data only. Search queries include `is:public`, and evidence from private repositories is dropped. Use a fine-grained GitHub token with "Public repositories (read-only)" access and nothing else. `GITHUB_TOKEN` is required in every environment: GitHub returns a profile's public email only to authenticated requests, so without it Scout finds no email routes.
- Evidence order: merged pull requests into the repositories that were searched come first, then the person's own public repositories, then other merged pull requests ranked by the target repository's star count, then their own commits only if fewer than three items were found, at most five in all. Own repositories are chosen by the search's languages, then recency; personal sites, forks, archived repositories and non-code repositories are skipped. Pull requests into forks, archived repositories and repositories with fewer than 5 stars are dropped when better evidence exists. This ordering is internal and never shown as a score.
- Model privacy: requests go through OpenRouter with `provider.data_collection = "deny"`, which tells OpenRouter to route only to endpoints that do not collect data ([`src/model.ts`](src/model.ts)). OpenRouter routes to third-party hosts; this README makes no claim about any particular model vendor's own endpoints.
- UK GDPR: Scout processes personal data of people who did not ask to be contacted. Trigger.dev (run storage and traces) and OpenRouter (model input) process that data on the way. The lawful basis, a privacy notice and an objection route are the operator's responsibility. If you run Scout, you are the controller and must choose and document your lawful basis (usually legitimate interests for recruiting); this is not legal advice. Publishing a recording that shows real candidates is a further use of their public data that the operator answers for; a demo video does this and offers a removal route (see Removal requests).
- Opt-out: every email ends with "Not interested? Reply 'no thanks' and you won't hear from us again." Honoring a reply is manual for now. Look up the person's numeric GitHub id (`https://api.github.com/users/<login>`, field `id`), then run:

  ```sql
  INSERT INTO suppressed_contacts (github_user_id, github_login, reason, added_by)
  VALUES (<id>, '<login>', 'opted_out', '<your name>')
  ON CONFLICT (github_user_id) DO NOTHING;
  ```

  From then on Scout will not draft, approve or send to that person. To also erase their outreach records, `DELETE FROM outreach WHERE github_user_id = <id>;`.
- Removal requests, including removal from any demo video: open an issue on this repository; the owner does the steps above and cuts the clip.

## Setup

Requirements: Node 22+, Docker, a Trigger.dev account, a Slack workspace (the manifest below is written for a Free workspace), Docker Postgres locally (Neon or any Postgres if you deploy), OpenRouter, Scaleway Transactional Email, a fine-grained read-only GitHub token (public repositories only).

1. Install: `npm install`.
2. Database: `npm run db:up` (Postgres 17 on 127.0.0.1:54329, user, password and database all `scout`), then `DATABASE_URL=postgres://scout:scout@localhost:54329/scout npm run migrate`. Migrations are numbered files in `src/db/migrations`; `npm run migrate` applies the ones not yet recorded and is safe to run again. They run from your machine, never from a task. If you deploy, run it against your production database before `npx trigger deploy`. For Neon, use its connection string with `sslmode=require`; the client then verifies the server certificate.
3. Environment: copy the names from [`.env.example`](.env.example) into a file outside the repo (for example `~/.config/scout/secrets.env`, mode 600). Names: `SLACK_BOT_TOKEN`, `GITHUB_TOKEN`, `OPENROUTER_API_KEY`, `MODEL_ID`, `SCW_SECRET_KEY`, `SCW_PROJECT_ID`, `EMAIL_FROM`, `REPLY_TO`, `SCOUT_AUDIT_HEADER`, `DATABASE_URL`, `APPROVER_SLACK_IDS`, `DEMO_MODE`, `DEMO_ALLOWED_LOGINS`, `SEND_ALLOWED_RECIPIENTS`, `SEND_MODE`, `OUTREACH_SIGNATURE`, plus `TRIGGER_SECRET_KEY` for the CLI only. `MODEL_ID` defaults to `deepseek/deepseek-v4.1-flash`. Values containing spaces or angle brackets must be quoted if a shell sources the file, for example `EMAIL_FROM="Scout <scout@example.com>"`. The Slack signing secret is NOT an env var: it is set on the Trigger.dev endpoint.
4. Run locally: `npx trigger dev --env-file ~/.config/scout/secrets.env`. With `--env-file`, only that file is read, and `TRIGGER_SECRET_KEY` in it is ignored for tasks (the CLI uses its own login).
5. Slack app: create it from [`slack-manifest.yaml`](slack-manifest.yaml) (bot scopes `app_mentions:read`, `channels:history`, `chat:write`, `reactions:write`; events `app_mention`, `message.channels`; interactivity on). Put the endpoint URL from the Trigger.dev Webhooks page in BOTH request URLs. Then, before clicking Verify, set the app's Signing Secret as the endpoint's signing secret (dashboard "Set signing secret"). Every delivery is rejected while the endpoint shows "Needs secret". Install the app, invite it to #hiring, and mention it.
Not yet run: steps 6 and 7 describe the production cut-over as planned; so far Scout has run only on the dev environment.

6. When you deploy, create a second Slack app from the same manifest: keep "Scout dev" on the dev endpoint URL and give the new "Scout" app the prod endpoint URL, so development keeps working after the cut-over.
7. Prod cut-over, in this order: `npx trigger deploy`; set the prod endpoint's signing secret; set prod environment variables in the dashboard (mark `DATABASE_URL` and keys as Secret); create the "Scout" Slack app with both request URLs on the prod endpoint; Verify; run a full live check.

### Reconciling a `send_unknown` or stuck `sending` row

A row in `send_unknown` means the email API did not give a clear answer, so the email may or may not have been sent. A row that stays in `sending` means the worker stopped between claiming the row and recording the result (Scout does not record when the claim happened, so check in the Trigger.dev dashboard that the run is no longer going). Scout never retries either, refuses to send them, and they keep the never-twice slot until a person decides.

1. Find the rows: `SELECT id, status, github_login, contact_value, subject, decided_at FROM outreach WHERE status IN ('send_unknown', 'sending');`
2. Check Scaleway for that recipient. In the Scaleway console, open Transactional Email and look at the emails for your project; or call ListEmails (`GET /transactional-email/v1alpha1/regions/fr-par/emails`) with `project_id`, `mail_rcpt`, `since` set to 10 minutes before `decided_at`, `until` set to now, and `subject`. Scout does not record the attempt time, and a rate-limited attempt can return the row to `approved` for a later retry, so the attempt that ended in `send_unknown` can be much later than `decided_at`. If any matching email has status `new`, `sending` or `sent`, it was sent.
3. If an email exists with status `new`, `sending` or `sent`, record it: `UPDATE outreach SET status = 'sent', provider_message_id = '<email id>', sent_at = now(), error = NULL WHERE id = <id> AND status IN ('send_unknown', 'sending');`
4. If there is none, or it is `failed` or `canceled`, free the slot: `UPDATE outreach SET status = 'failed' WHERE id = <id> AND status IN ('send_unknown', 'sending');` and ask for a fresh draft. (`sent_at` in step 3 is the time of reconciliation, not of delivery.)

## Webhooks beta feedback

These come from building Scout against `@trigger.dev/sdk` and `@trigger.dev/slack` 4.8.1. Items marked hit live were observed during the live runs on 2026-10-27; the others were verified by reading the installed packages and docs.

- Click hooks are typed with `SlackMessageEvent` but receive `SlackBlockActions`, so reading the clicker or `response_url` needs a cast. Confirmed in the types and needed in this code. Suggestion: type the hooks' event as the union, or export a guard.
- Wrapping `onInteraction` and `finalizeInteraction` on `slack()` works and is exactly what an approval record needs, but the Slack page does not document it. Two facts that matter for safety are also undocumented: `onInteraction` runs several times per event, including for plain messages, and a throw in `finalizeInteraction` is swallowed and the run resumes. Hit live: the approval click was recorded through `finalizeInteraction`.
- A click on a card whose tool call is no longer pending is dropped silently, with no hook and no feedback to the clicker. Verified in source; the visible effect is not yet observed.
- No exported helper for `replace_original`; I wrote a guarded `fetch` on the click's `response_url` using the exported `isSlackResponseUrl`.
- `maxDuration` is required in `trigger.config.ts` but missing from the minimal config example. Verified in source and docs; not hit at runtime because I set it from the start.
- Cards with GitHub links unfurl into a stack of previews (hit live, 2026-10-27). Neither `chat.surface().post()` nor the connector's send exposes `unfurl_links` / `unfurl_media`: `makeSlackSend` and `makeSlackSurface` forward only `text` and `blocks`, and `ChannelMessage` allows extra keys but they are dropped. Workaround: a direct `chat.postMessage` for Scout's own posts and a link-free approval card. Suggestion: forward unknown `ChannelMessage` keys to `chat.postMessage`, or add an unfurl option to `slack()`.
- With delivery `final`, text the model wrote before its tool calls is posted after the messages those tools posted mid-turn, so a preamble like "I'll search GitHub" lands under the cards (hit live, 2026-10-27). Workaround: prompt the model to write nothing before tools and build the reply from tool results. Suggestion: with delivery `final`, drop or flush pre-tool text when a tool posted to the thread during the turn.

What worked well: the no-`execute` tool pause and resume made the approval flow small; the hosted endpoint removed signature and dedup code; the connector is a plain object that could be wrapped without forking.

## Notes on the email provider

Scaleway Transactional Email is called with plain `fetch` ([`src/email/scaleway.ts`](src/email/scaleway.ts)): one POST per approved draft, plain text only, with `Reply-To` set to `REPLY_TO`, a `List-Unsubscribe` header pointing at a mailto link on that address, and an `X-Scout-Outreach` audit header (`<outreach id>:<draft hash>`) that appears in the delivered mail only. Its API reference documents a 200 response and no error codes or rate-limit behavior. If the API ever rejects the `X-Scout-Outreach` header, set `SCOUT_AUDIT_HEADER=false`; `Reply-To` stays. If it rejects `List-Unsubscribe`, the send fails with an error naming the header and nothing is sent. The `X-Scout-Outreach` header was accepted on the first live send; the `List-Unsubscribe` header was added afterwards and has not yet been sent live. A 2xx means the email was accepted into Scaleway's queue, not delivered. There is no idempotency key, which is why the send is claimed in the database before the call.

### Deliverability

Set up SPF (Scaleway's include is `_spf.tem.scaleway.com`) and DKIM for your sending domain in the Scaleway console; start DMARC at `p=none` and move to `p=quarantine` once sends are stable. A new sender lands in Spam at first. Before recording, send one test to your own address and mark it Not spam or add the sender as a contact. If you want, set `EMAIL_FROM` to a real person's display name, for example `Your Name <scout@example.com>`, and set `OUTREACH_SIGNATURE` to one line such as `Your Name, founder, Your Company`; when set, it is appended to every draft before the opt-out line and is part of the hashed text. The first live send landed in Gmail's Spam folder, which is why the advice above exists.

## Next

- More sources: Hacker News "who is hiring" threads, ATS exports, referrals.
- ATS integration, for example importing inbound applications.
- Honor "no thanks" replies automatically instead of by hand.
- A dedicated, narrowly scoped Scaleway key (create-email and read-only).
- A `scripts/reconcile.ts` for `send_unknown` rows (today it is the manual check above).
- Replace superseded approval cards in Slack so an old card stops looking clickable.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
