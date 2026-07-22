/**
 * Pure decision logic for the approval resolution event. The plugin subscribes
 * to the generic `approval.decided` broadcast and decides whether to enqueue a
 * deployment dispatch. Only approvals originated by this plugin ("external
 * automation") that were approved lead to a dispatch; rejection, supersession,
 * or foreign approvals never dispatch.
 */
export interface ApprovalDecidedEvent {
  approvalId: string;
  decision: string;
  status: string;
  type: string;
  sourcePluginId: string | null;
}

export interface ResolutionDecision {
  enqueueDispatch: boolean;
  reason: string;
}

export const SELF_PLUGIN_ID = "insightflo.github-repository-bridge";

export function decideResolutionAction(event: ApprovalDecidedEvent): ResolutionDecision {
  // Only approvals originated by THIS plugin may dispatch. A null or foreign
  // sourcePluginId never dispatches (strict equality).
  if (event.sourcePluginId !== SELF_PLUGIN_ID) {
    return { enqueueDispatch: false, reason: `approval not originated by this plugin (sourcePluginId=${event.sourcePluginId ?? "null"})` };
  }
  if (event.type !== "external_automation") {
    return { enqueueDispatch: false, reason: `non-deploy approval type: ${event.type}` };
  }
  if (event.decision !== "approved") {
    return { enqueueDispatch: false, reason: `approval ${event.decision}; no dispatch` };
  }
  if (event.status !== "approved") {
    return { enqueueDispatch: false, reason: `approval status is ${event.status}; no dispatch` };
  }
  return { enqueueDispatch: true, reason: "approved; enqueue dispatch for the exact recorded commit" };
}
