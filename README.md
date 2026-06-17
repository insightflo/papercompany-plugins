# Papercompany Plugins

Standalone development workspace for Papercompany/Paperclip plugins.

## Scope

Runtime core stays in `../papercompany-runtime`. Plugin packages live here and are installed into a Paperclip runtime via the plugin manager.

Current packages:

- `packages/tool-registry`
- `packages/research-workbench`
- `packages/service-request-bridge`
- `packages/knowledge-base`
- `packages/system-garden`

Note: the former `packages/workflow-engine` plugin has been retired. Workflow
execution now lives in `../papercompany-runtime` core/native services; the
runtime preserves compatibility for the legacy `insightflo.workflow-engine`
plugin key without activating this plugin worker.

## SDK snapshot

This workspace keeps a local SDK/shared snapshot under `.paperclip-sdk/` so plugin packages can build and test without importing runtime source files directly:

- `.paperclip-sdk/plugin-sdk`
- `.paperclip-sdk/shared`

Plugin packages currently reference those snapshots with `file:../../.paperclip-sdk/...` dependencies. For registry deployment, replace those with the published/private-registry versions that match the target runtime.

## Local development

Install and verify:

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

Install a plugin into a local Paperclip runtime from its source path:

```sh
cd ../papercompany-runtime
pnpm paperclipai plugin install /Users/kwak/Projects/ai/papercompany/papercompany-plugins/packages/research-workbench --local
```

For production deployment, publish plugin packages to npm or a private npm-compatible registry, then install by package name through the runtime plugin manager.
