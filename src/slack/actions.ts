import { z } from "zod";
import type { ClickInfo } from "./finalize.js";

export const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("never_show"),
    githubUserId: z.number().int().positive(),
    login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
  }),
]);

export type ScoutAction = z.infer<typeof actionSchema>;

export type ActionDeps = {
  approvers: ReadonlySet<string>;
  suppress: (input: { githubUserId: number; githubLogin: string; addedBy: string }) => Promise<void>;
};

export async function handleAction(
  action: ScoutAction,
  click: Pick<ClickInfo, "userId">,
  deps: ActionDeps,
): Promise<string> {
  const uid = click.userId;
  if (!uid || !deps.approvers.has(uid)) {
    return `A non-approver tried to add ${action.login} to the do-not-contact list. Nothing was changed. Say in one short sentence that only approvers can do this.`;
  }
  try {
    await deps.suppress({ githubUserId: action.githubUserId, githubLogin: action.login, addedBy: uid });
  } catch {
    return `Adding ${action.login} to the do-not-contact list failed. Nothing was changed. Say so in one short sentence and suggest trying again.`;
  }
  return `${action.login} was added to the do-not-contact list by an approver and will not be shown again. Confirm that in one short sentence.`;
}
