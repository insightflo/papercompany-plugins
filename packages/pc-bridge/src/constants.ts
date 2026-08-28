export const PLUGIN_ID = "pc-bridge";
export const PLUGIN_VERSION = "0.2.0";

export const PAGE_ROUTE = "pc-bridge";

export const SLOT_IDS = {
  page: "pc-bridge.page",
  sidebar: "pc-bridge.sidebar",
} as const;

export const EXPORT_NAMES = {
  page: "PcBridgePage",
  sidebar: "PcBridgeSidebarLink",
} as const;

export const TOOL_NAMES = {
  dispatch: "pc-bridge-dispatch",
} as const;

export const DATA_KEYS = {
  status: "status",
} as const;

export const ACTION_KEYS = {
  dispatch: "dispatch",
} as const;

export const WEBHOOK_ENDPOINT_KEYS = {
  dispatch: "dispatch",
} as const;

/**
 * Handler naming contract shared with the mac bridge handlers/ directory
 * whitelist: lowercase alphanumerics and hyphens, 1–64 chars.
 */
export const HANDLER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Operator PC (mac) bridge base URL. The A1 SSH reverse tunnel (-R) exposes the
 * mac bridge listener on the A1 loopback, so the default is a loopback address.
 */
export const DEFAULT_BRIDGE_BASE_URL = "http://127.0.0.1:8930";

export const DISPATCH_PATH = "/dispatch";

/** Header the mac bridge requires on POST /dispatch. */
export const WEBHOOK_KEY_HEADER = "x-papercompany-webhook-key";

/**
 * Mac handler timeout is 480s; the plugin timeout must exceed it to receive the
 * handler's own verdict instead of a local timeout.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 540_000;
export const MIN_REQUEST_TIMEOUT_MS = 1_000;
export const MAX_REQUEST_TIMEOUT_MS = 900_000;

export const DEFAULT_HISTORY_LIMIT = 50;
export const MIN_HISTORY_LIMIT = 1;
export const MAX_HISTORY_LIMIT = 500;

/** History entries keep a params snapshot; cap it so one huge payload can't bloat state. */
export const MAX_PARAMS_SNAPSHOT_CHARS = 2_000;
