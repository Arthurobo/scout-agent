import { tool } from "ai";
import { approvalInput, approvalOutput } from "../slack/approval.js";

export const requestOutreachApproval = tool({
  title: "Request outreach approval",
  description:
    "Ask a human approver in Slack to approve one outreach draft. Pass outreachId, subject and body exactly as prepareOutreach returned them. Has no side effects until a person clicks; the result is the click outcome.",
  inputSchema: approvalInput,
  outputSchema: approvalOutput,
});
