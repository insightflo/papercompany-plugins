import { definePlugin, runWorker, type PluginContext, type PluginEvent } from "@paperclipai/plugin-sdk";
import { processGitHubWebhook } from "./bridge.js";
import { validateBridgeConfig, requireBridgeConfig } from "./config.js";
import { handleApprovalDecided, drainOutbox } from "./deploy-approvals.js";

let pluginContext: PluginContext | null = null;

const DRAIN_JOB_KEY = "drain-dispatch-outbox";

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    pluginContext = ctx;
    // Listen for generic approval resolutions and dispatch the exact approved
    // commit. Filter to approvals originated by this plugin; the host already
    // limits the broadcast to plugin-requested approvals.
    ctx.events.on("approval.decided", async (event: PluginEvent) => {
      try {
        const config = requireBridgeConfig(await ctx.config.get());
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const sourcePluginId = typeof payload.sourcePluginId === "string" ? payload.sourcePluginId : null;
        await handleApprovalDecided(ctx, config, {
          approvalId: event.entityId ?? "",
          decision: typeof payload.decision === "string" ? payload.decision : "",
          status: typeof payload.status === "string" ? payload.status : "",
          type: typeof payload.type === "string" ? payload.type : "",
          sourcePluginId,
        });
      } catch (error) {
        ctx.logger.warn("approval.decided handling failed", {
          approvalId: event.entityId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    // Periodically drain the retryable dispatch outbox.
    ctx.jobs.register(DRAIN_JOB_KEY, async () => {
      try {
        const config = requireBridgeConfig(await ctx.config.get());
        await drainOutbox(ctx, config);
      } catch (error) {
        ctx.logger.warn("dispatch outbox drain failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    ctx.logger.info("GitHub Repository Bridge worker ready");
  },
  async onWebhook(input) {
    const ctx = pluginContext;
    if (!ctx) throw new Error("GitHub Repository Bridge is not initialized");
    await processGitHubWebhook(ctx, input);
  },
  async onValidateConfig(config) {
    return validateBridgeConfig(config);
  },
  async onHealth() {
    return pluginContext
      ? { status: "ok", message: "GitHub Repository Bridge is ready in shadow mode" }
      : { status: "degraded", message: "GitHub Repository Bridge is not initialized" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
