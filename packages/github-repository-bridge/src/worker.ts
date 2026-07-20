import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { processGitHubWebhook } from "./bridge.js";
import { validateBridgeConfig } from "./config.js";

let pluginContext: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    pluginContext = ctx;
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
