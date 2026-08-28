import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  ACTION_KEYS,
  DATA_KEYS,
  DEFAULT_BRIDGE_BASE_URL,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DISPATCH_PATH,
  EXPORT_NAMES,
  HANDLER_NAME_PATTERN,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  TOOL_NAMES,
  WEBHOOK_ENDPOINT_KEYS,
} from "./constants.js";

const capabilities = [
  "http.outbound",
  "secrets.read-ref",
  "plugin.state.read",
  "plugin.state.write",
  "agent.tools.register",
  "webhooks.receive",
  "ui.page.register",
  "ui.sidebar.register",
] as unknown as PaperclipPluginManifestV1["capabilities"];

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "PC Bridge (범용 PC 기능 호출)",
  description:
    "A1에서 실행할 수 없는 기능을 운영자 PC(맥) 브리지의 등록된 핸들러로 전달하는 범용 디스패치 플러그인. {handler, params} 하나로 호출하고, params 검증은 PC 측 핸들러가 담당합니다. 네이버 블로그 발행은 핸들러 1종(naver-publish)의 예시입니다.",
  author: "InsightFlo",
  categories: ["automation", "connector"],
  capabilities,
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  tools: [
    {
      name: TOOL_NAMES.dispatch,
      displayName: "PC 브리지 기능 호출",
      description: [
        "운영자 PC(맥) 브리지에 등록된 핸들러를 호출합니다.",
        "handler는 맥의 handlers/ 디렉터리에 실행 파일로 등록된 이름([a-z0-9-] 형식)이어야 합니다.",
        "params는 핸들러가 요구하는 JSON 객체이며, 검증은 핸들러가 담당합니다.",
        '예: 네이버 발행은 {"handler":"naver-publish","params":{"url":"https://...","workflow":"gazua-morning"}}',
      ].join(" "),
      parametersSchema: {
        type: "object",
        properties: {
          handler: {
            type: "string",
            description: "호출할 핸들러 이름 (맥 handlers/ 디렉터리에 등록된 [a-z0-9-] 형식 이름)",
            pattern: HANDLER_NAME_PATTERN.source,
          },
          params: {
            type: "object",
            description: "핸들러로 전달할 JSON 객체 (핸들러가 스스로 검증합니다)",
          },
        },
        required: ["handler", "params"],
      },
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_ENDPOINT_KEYS.dispatch,
      displayName: "PC Bridge Dispatch",
      description:
        "A1 스크립트가 {handler, params} 디스패치를 직접 POST하기 위한 fire-and-forget 엔드포인트. " +
        "헤더 X-Papercompany-Webhook-Key 필수. 접수만 확인하며 실행 결과는 플러그인 이력에 기록된다.",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      bridgeBaseUrl: {
        type: "string",
        title: "PC 브리지 주소",
        description: "SSH -R 터널로 A1 루프백에 노출된 맥 브리지 주소",
        default: DEFAULT_BRIDGE_BASE_URL,
      },
      webhookKeyRef: {
        type: "string",
        title: "웹훅 키 시크릿 참조",
        description: "맥 브리지 웹훅 키의 시크릿 참조 (권장)",
      },
      webhookKey: {
        type: "string",
        title: "웹훅 키 (인라인)",
        description: "시크릿 참조를 사용하지 않을 때의 인라인 폴백. 코드에 하드코딩하지 말고 설정에만 입력하세요.",
      },
      requestTimeoutMs: {
        type: "number",
        title: "요청 타임아웃(ms)",
        description: `맥 브리지 디스패치 타임아웃. 맥 핸들러 타임아웃(480초)보다 커야 판정을 받을 수 있습니다 (기본 ${DEFAULT_REQUEST_TIMEOUT_MS}ms).`,
        default: DEFAULT_REQUEST_TIMEOUT_MS,
      },
      historyLimit: {
        type: "number",
        title: "디스패치 이력 최대 보관 수",
        default: DEFAULT_HISTORY_LIMIT,
      },
    },
  },
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "PC Bridge",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "PC Bridge",
        exportName: EXPORT_NAMES.sidebar,
      },
    ],
  } as PaperclipPluginManifestV1["ui"],
};

export default manifest;
