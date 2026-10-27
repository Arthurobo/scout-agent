import { webhooks } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { appMentions, webhookSource, type SlackBlockActions } from "@trigger.dev/slack";
import { stepCountIs } from "ai";
import { ConfigError, loadConfig, requireGitHubToken } from "../config.js";
import { getDb } from "../db/client.js";
import { suppressContact } from "../db/queries.js";
import { createModel } from "../model.js";
import { buildSystemPrompt } from "../prompt.js";
import { actionSchema, handleAction } from "../slack/actions.js";
import { scoutSlack } from "../slack/connector.js";
import { turnStore } from "../slack/turn.js";
import { defaultDeps } from "../tools/deps.js";
import { makePostCandidateCard } from "../tools/postCandidateCard.js";
import { makePrepareOutreach } from "../tools/prepareOutreach.js";
import { requestOutreachApproval } from "../tools/requestOutreachApproval.js";
import { makeSearchGitHub } from "../tools/searchGitHub.js";
import { makeSendOutreach } from "../tools/sendOutreach.js";

const slackEvents = webhooks.endpoint.define({ id: "slack", source: webhookSource() });

const approvers = () => new Set(loadConfig(["APPROVER_SLACK_IDS"]).APPROVER_SLACK_IDS);

const deps = defaultDeps();

export const scout = chat.agent({
  id: "scout",
  turnTimeout: "24h",
  system: buildSystemPrompt({ sendEnabled: true }),
  channels: [
    scoutSlack({
      id: "slack",
      endpoint: slackEvents,
      token: () => loadConfig(["SLACK_BOT_TOKEN"]).SLACK_BOT_TOKEN,
      startOn: appMentions(),
      approvers,
      onThread: (info) => turnStore.setThread(info),
    }),
  ],
  actionSchema,
  onAction: async ({ action, channel }) => {
    const click = channel?.event as SlackBlockActions | undefined;
    const message = await handleAction(
      action,
      { userId: click?.user?.id },
      {
        approvers: approvers(),
        suppress: (input) => suppressContact(getDb(), input),
      },
    );
    return chat.turn(message);
  },
  tools: {
    searchGitHub: makeSearchGitHub(deps),
    postCandidateCard: makePostCandidateCard(deps),
    prepareOutreach: makePrepareOutreach(deps),
    sendOutreach: makeSendOutreach(deps),
    requestOutreachApproval,
  },
  run: async ({ ctx, messages, tools, signal, streamText }) => {
    turnStore.setRunId(ctx.run.id);
    try {
      requireGitHubToken();
      return streamText({
        model: createModel(),
        messages,
        tools,
        abortSignal: signal,
        stopWhen: stepCountIs(12),
      });
    } catch (err) {
      if (err instanceof ConfigError) console.error(err.message);
      throw err;
    }
  },
});
