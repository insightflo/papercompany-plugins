import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  type CSSProperties,
  type FormEvent,
  type JSX,
  useState,
} from "react";
import { ACTION_KEYS, DATA_KEYS } from "../constants.js";

type DispatchHistoryEntry = {
  id: string;
  requestedAt: string;
  source: string;
  handler: string;
  paramsSnapshot: string;
  ok: boolean;
  httpStatus: number | null;
  permalink: string | null;
  title: string | null;
  imageCount: number | null;
  error: string | null;
  message: string | null;
  durationMs: number;
};

type StatusSnapshot = {
  generatedAt: string;
  config: {
    bridgeBaseUrl: string;
    webhookKeyRef: string;
    webhookKeyConfigured: boolean;
    requestTimeoutMs: number;
    historyLimit: number;
  };
  healthNote: string;
  chainDoc: string;
  dispatchPath: string;
  history: DispatchHistoryEntry[];
};

type DispatchActionOutcome = {
  entry?: DispatchHistoryEntry;
  result?: {
    ok: boolean;
    httpStatus: number | null;
    body: Record<string, unknown> | null;
    error: string | null;
  };
  error?: string;
};

const pageStyle: CSSProperties = {
  display: "grid",
  gap: "12px",
  padding: "14px",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  color: "#e5e7eb",
};

const cardStyle: CSSProperties = {
  display: "grid",
  gap: "10px",
  padding: "12px",
  borderRadius: "10px",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  background: "rgba(255, 255, 255, 0.04)",
};

const mutedStyle: CSSProperties = {
  margin: 0,
  fontSize: "12px",
  color: "#9ca3af",
};

const monoStyle: CSSProperties = {
  ...mutedStyle,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  wordBreak: "break-all",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "12px",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  fontSize: "11px",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "#9ca3af",
  padding: "8px 10px",
  borderBottom: "1px solid rgba(255, 255, 255, 0.12)",
};

const tdStyle: CSSProperties = {
  verticalAlign: "top",
  padding: "8px 10px",
  borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid rgba(255, 255, 255, 0.16)",
  borderRadius: "8px",
  fontSize: "13px",
  background: "rgba(17, 24, 39, 0.9)",
  color: "#f9fafb",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: "88px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  resize: "vertical",
};

const buttonStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #111827",
  borderRadius: "8px",
  background: "#111827",
  color: "#ffffff",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 600,
};

function badgeStyle(ok: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    borderRadius: "999px",
    padding: "2px 8px",
    background: ok ? "#dcfce7" : "#fee2e2",
    color: ok ? "#166534" : "#991b1b",
    fontSize: "11px",
    fontWeight: 700,
  };
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(parsed);
}

function DataError({ error }: { error: unknown }): JSX.Element | null {
  if (!error) {
    return null;
  }

  return <p style={{ ...mutedStyle, color: "#b91c1c" }}>{(error as Error)?.message ?? String(error)}</p>;
}

function BridgeNoteSection({ snapshot }: { snapshot: StatusSnapshot }): JSX.Element {
  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center" }}>
        <strong style={{ fontSize: "14px" }}>맥 브리지 상태</strong>
        <span style={{ ...badgeStyle(false), background: "#f3f4f6", color: "#4b5563" }}>직접 확인 불가</span>
      </div>
      <p style={mutedStyle}>{snapshot.healthNote}</p>
      <p style={mutedStyle}>
        대상: <code>{snapshot.config.bridgeBaseUrl}{snapshot.dispatchPath}</code> · 웹훅 키:{" "}
        {snapshot.config.webhookKeyConfigured
          ? `설정됨${snapshot.config.webhookKeyRef ? ` (시크릿 참조: ${snapshot.config.webhookKeyRef})` : " (인라인)"}`
          : "미설정 — 디스패치 불가"}
      </p>
    </section>
  );
}

function DispatchForm({
  onSubmit,
}: {
  onSubmit: (values: { handler: string; params: Record<string, unknown> }) => Promise<DispatchActionOutcome>;
}): JSX.Element {
  const [handler, setHandler] = useState("");
  const [paramsText, setParamsText] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [resultMessage, setResultMessage] = useState("");
  const [isError, setIsError] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    let params: Record<string, unknown>;
    try {
      const trimmed = paramsText.trim() || "{}";
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("params는 JSON 객체여야 합니다.");
      }
      params = parsed as Record<string, unknown>;
    } catch (error) {
      setIsError(true);
      setResultMessage(error instanceof Error ? error.message : String(error));
      return;
    }

    setBusy(true);
    setResultMessage("");
    setIsError(false);

    try {
      const outcome = await onSubmit({ handler, params });

      if ("error" in outcome && outcome.error) {
        setIsError(true);
        setResultMessage(outcome.error);
        return;
      }

      if (outcome.result && outcome.result.ok) {
        const entry = outcome.entry;
        const lines = [
          `디스패치 완료: ${entry?.handler ?? handler}`,
          entry?.title ? `제목: ${entry.title}` : "",
          entry?.permalink ? `퍼머링크: ${entry.permalink}` : "",
          entry?.message ? `메시지: ${entry.message}` : "",
        ].filter(Boolean);
        setResultMessage(lines.join(" · "));
        return;
      }

      setIsError(true);
      const body = outcome.result?.body;
      const bodyMessage = body && typeof body.message === "string" ? body.message : "";
      setResultMessage(outcome.error ?? bodyMessage ?? "디스패치가 실패했습니다.");
    } catch (error) {
      setIsError(true);
      setResultMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={cardStyle}>
      <strong style={{ fontSize: "14px" }}>수동 디스패치</strong>
      <p style={mutedStyle}>
        맥 브리지에 등록된 핸들러 이름과 params JSON으로 기능을 호출합니다.
        params 검증은 핸들러가 담당합니다 (예: naver-publish는 url/workflow 규칙 검사).
      </p>
      <form onSubmit={(event) => void handleSubmit(event)} style={{ display: "grid", gap: "10px" }}>
        <label style={{ display: "grid", gap: "6px" }}>
          <span style={mutedStyle}>핸들러 이름 ([a-z0-9-])</span>
          <input
            required
            style={inputStyle}
            value={handler}
            onChange={(event) => setHandler(event.target.value)}
            placeholder="echo-test"
          />
        </label>

        <label style={{ display: "grid", gap: "6px" }}>
          <span style={mutedStyle}>params (JSON 객체)</span>
          <textarea
            style={textareaStyle}
            value={paramsText}
            onChange={(event) => setParamsText(event.target.value)}
            placeholder={'{"hello": "world"}'}
          />
        </label>

        {resultMessage ? (
          <p style={{ ...mutedStyle, color: isError ? "#b91c1c" : "#166534" }}>{resultMessage}</p>
        ) : null}

        <div>
          <button type="submit" style={buttonStyle} disabled={busy}>
            {busy ? "디스패치 중..." : "디스패치"}
          </button>
        </div>
      </form>
    </section>
  );
}

function HistorySection({ history }: { history: DispatchHistoryEntry[] }): JSX.Element {
  return (
    <section style={cardStyle}>
      <strong style={{ fontSize: "14px" }}>최근 디스패치 이력</strong>
      {history.length === 0 ? (
        <p style={mutedStyle}>아직 디스패치 이력이 없습니다.</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>시각</th>
              <th style={thStyle}>출처</th>
              <th style={thStyle}>핸들러 / params</th>
              <th style={thStyle}>결과</th>
            </tr>
          </thead>
          <tbody>
            {history.map((entry) => (
              <tr key={entry.id}>
                <td style={tdStyle}>{formatDateTime(entry.requestedAt)}</td>
                <td style={tdStyle}>{entry.source}</td>
                <td style={tdStyle}>
                  <div style={{ display: "grid", gap: "3px" }}>
                    <span style={{ wordBreak: "break-all" }}>{entry.handler}</span>
                    {entry.paramsSnapshot ? <span style={monoStyle}>{entry.paramsSnapshot}</span> : null}
                  </div>
                </td>
                <td style={tdStyle}>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <span style={badgeStyle(entry.ok)}>{entry.ok ? "성공" : "실패"}</span>
                    {entry.permalink ? (
                      <a href={entry.permalink} target="_blank" rel="noopener" style={{ ...mutedStyle, wordBreak: "break-all" }}>
                        {entry.permalink}
                      </a>
                    ) : null}
                    {entry.title ? <span style={mutedStyle}>{entry.title}</span> : null}
                    {typeof entry.imageCount === "number" ? (
                      <span style={mutedStyle}>이미지 {entry.imageCount}장</span>
                    ) : null}
                    {entry.error ? <span style={{ ...mutedStyle, color: "#b91c1c" }}>{entry.error}</span> : null}
                    {entry.message && !entry.error ? <span style={mutedStyle}>{entry.message}</span> : null}
                    <span style={mutedStyle}>{Math.round(entry.durationMs / 100) / 10}s</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ChainDocSection({ snapshot }: { snapshot: StatusSnapshot }): JSX.Element {
  return (
    <section style={cardStyle}>
      <strong style={{ fontSize: "14px" }}>체인 구조 (호출 → 실행)</strong>
      <p style={mutedStyle}>{snapshot.chainDoc}</p>
      <p style={mutedStyle}>
        핸들러는 맥의 <code>handlers/</code> 디렉터리에 실행 파일을 추가하는 것만으로 늘어나며,
        호출은 언제나 <code>{"{handler, params}"}</code> 하나다. 네이버 블로그 발행은 그 핸들러 1종의 예시다.
      </p>
    </section>
  );
}

export function PcBridgePage(_props: PluginPageProps): JSX.Element {
  const snapshot = usePluginData<StatusSnapshot>(DATA_KEYS.status, {});
  const dispatch = usePluginAction(ACTION_KEYS.dispatch);

  async function handleDispatch(values: { handler: string; params: Record<string, unknown> }): Promise<DispatchActionOutcome> {
    const outcome = await dispatch({ handler: values.handler, params: values.params });
    await snapshot.refresh();
    return outcome as DispatchActionOutcome;
  }

  return (
    <div style={pageStyle}>
      <section style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center" }}>
          <strong style={{ fontSize: "14px" }}>PC Bridge (범용 PC 기능 호출)</strong>
          <button type="button" style={buttonStyle} onClick={snapshot.refresh}>
            새로고침
          </button>
        </div>
        <DataError error={snapshot.error} />
        {snapshot.loading ? <p style={mutedStyle}>상태를 불러오는 중...</p> : null}
      </section>

      {snapshot.data ? <BridgeNoteSection snapshot={snapshot.data} /> : null}

      <DispatchForm onSubmit={handleDispatch} />

      <HistorySection history={snapshot.data?.history ?? []} />

      {snapshot.data ? <ChainDocSection snapshot={snapshot.data} /> : null}

      <section style={cardStyle}>
        <strong style={{ fontSize: "14px" }}>A1에서 호출하기</strong>
        <p style={mutedStyle}>
          에이전트 툴 <code>pc-bridge-dispatch</code> (파라미터 <code>handler</code> + <code>params</code> 객체) 또는 웹훅{" "}
          <code>POST /api/plugins/pc-bridge/webhooks/dispatch</code>{" "}
          (헤더 <code>X-Papercompany-Webhook-Key</code>, JSON 본문 <code>{"{handler, params}"}</code>)로 호출할 수 있습니다.
          웹훅은 fire-and-forget — 접수만 확인하고 결과는 이력에 기록됩니다.
        </p>
      </section>
    </div>
  );
}

export function PcBridgeSidebarLink({ context }: { context?: { companyPrefix?: string | null } }): JSX.Element {
  const host = useHostContext();
  const prefix = host.companyPrefix ?? context?.companyPrefix ?? "";
  const href = prefix ? `/${prefix}/pc-bridge` : "/pc-bridge";
  const isActive = typeof window !== "undefined" && window.location.pathname === href;

  return (
    <a
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "8px 12px",
        fontSize: "13px",
        fontWeight: 500,
        textDecoration: "none",
        color: isActive ? "var(--foreground, #f8fafc)" : "color-mix(in srgb, var(--foreground, #f8fafc) 80%, transparent)",
        background: isActive ? "var(--accent, rgba(125,211,252,0.12))" : "transparent",
        borderRadius: "8px",
      }}
    >
      <span>🖥️ PC Bridge</span>
    </a>
  );
}
