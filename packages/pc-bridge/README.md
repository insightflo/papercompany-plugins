# PC Bridge Plugin (범용 PC 기능 호출)

운영자 PC(맥)에 등록된 **기능(핸들러)**을 서버에서 호출하는 범용 브리지 플러그인.

**핸들러는 PC에 추가하고, 호출은 `{handler, params}` 하나로.**
이 플러그인은 호출-연결(전달·기록)만 담당한다. 기능별 지식(params 검증 — 카테고리 매핑,
호스트 화이트리스트 등)은 호출자(워크플로우)와 PC 측 핸들러가 담당한다.
네이버 블로그 발행은 핸들러 1종(`naver-publish`)의 **예시**일 뿐이다.

## 체인 구조 (큐 방식)

```
호출자 (서버 에이전트 툴 / 스크립트 웹훅)
 └─ 이 플러그인 pc-bridge                     ← {handler, params} 형식 검증만 (이력 기록)
     └─ SSH 역방향 터널 서버 127.0.0.1:8930 → 맥 127.0.0.1:8930
         └─ 맥 bridge_server POST /dispatch    ← 키 인증·중복차단(7일)·레이트리밋·감사로그
             └─ handlers/<이름> 서브프로세스    ← params는 stdin JSON, 검증은 핸들러 책임
                 └─ 결과: stdout 마지막 줄 JSON {"ok":bool, "message":..., ...}
```

- 툴/UI 호출은 결과를 동기로 받는다 (맥 핸들러 타임아웃 480초 + 여유 = 플러그인 기본 타임아웃 540초).
- **웹훅은 fire-and-forget** — 접수(키·형식 검증)만 확인하고 즉시 반환하며, 실행 결과는 플러그인 이력에 기록된다.
- 맥 브리지 사본(`bridge_server.py`, `handlers/`)은 이 저장소의 `pc-bridge-mac/` 디렉터리가 배포 원본이다.

## 검증 규칙 (플러그인은 전달 전 최소 형식만)

- `handler`: `[a-z0-9-]` 형식 문자열(1~64자). 맥의 `handlers/` 디렉터리 화이트리스트와 같은 규약.
- `params`: JSON 객체 (생략 시 `{}`).
- 그 외 모든 params 검증은 **핸들러가** 수행한다. 예: `naver-publish`는
  `url`(https + 호스트 `manual-onboarding.pages.dev`|`gazua.showk.ing`)과
  `workflow` 6종→카테고리 매핑(`tech-ai-news`→AI뉴스, `tech-ai-scout`→AI소프트웨어,
  `agent-team-concept-radar`→AI개념, `youtube-report`→AI유투브요약, `gazua-morning`→한국증시,
  `gazua-evening`→미국증시) 또는 `category` 직접 지정을 스스로 검증한다.

## 설정

| 키 | 설명 |
|---|---|
| `bridgeBaseUrl` | 맥 브리지 주소 (기본 `http://127.0.0.1:8930`) |
| `webhookKeyRef` | 웹훅 키 시크릿 참조 (권장) |
| `webhookKey` | 인라인 웹훅 키 (시크릿 미사용 시 폴백) |
| `requestTimeoutMs` | 디스패치 요청 타임아웃 (기본 540000ms — 맥 핸들러 480초보다 커야 판정을 받음) |
| `historyLimit` | 디스패치 이력 최대 보관 수 (기본 50) |

웹훅 키는 설정/시크릿에서만 읽으며 코드에 하드코딩되지 않는다.

건강검진(health): 맥 브리지는 SSH 터널 뒤 루프백에서만 접근 가능해 **플러그인에서 직접 확인할 수 없다**.
UI는 이 사실을 그대로 표기하며, 각 디스패치의 성공/실패는 이력으로 확인한다.

## 서버에서 호출하는 방법

1. **에이전트 툴 (권장)** — 워크플로우/에이전트가 툴 `pc-bridge-dispatch` 호출:
   ```json
   { "handler": "naver-publish", "params": { "url": "https://gazua.showk.ing/morning/2026-08-28", "workflow": "gazua-morning" } }
   ```
   핸들러가 무엇이든 호출은 이 형태 하나다. 결과(`content` + `data.response`)로 핸들러의 JSON 판정을 받는다.

2. **웹훅 (스크립트용, fire-and-forget)** — Paperclip 서버 API로 직접 POST:
   ```sh
   curl -X POST http://<paperclip>/api/plugins/pc-bridge/webhooks/dispatch \
     -H 'Content-Type: application/json' \
     -H 'X-Papercompany-Webhook-Key: <맥 브리지 웹훅 키와 동일한 값>' \
     -d '{"handler":"naver-publish","params":{"url":"https://gazua.showk.ing/morning/2026-08-28","workflow":"gazua-morning"}}'
   ```
   플러그인이 키를 검증(타이밍-세이프 비교)한 뒤 맥 브리지로 전달한다.
   웹훅 응답은 접수 성공/실패만 알리며, 실행 결과는 UI 이력에서 확인한다.

3. **UI 수동 디스패치** — 사이드바 "PC Bridge" 페이지에서 핸들러 이름 + params JSON으로
   임의의 등록 핸들러를 호출하고, 최근 디스패치 이력과 체인 구조 설명을 본다.

## Build

```bash
cd packages/pc-bridge
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

## Install (example)

```bash
paperclipai plugin install --api-base http://localhost:3100 ./packages/pc-bridge
```
