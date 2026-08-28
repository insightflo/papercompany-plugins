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

## 운영자 PC 설정 (필수) — 플러그인 설치만으로는 동작하지 않습니다

플러그인은 서버에서 큐에 줄을 넣는 역할만 합니다. 실제 실행은 운영자 PC(맥)에서 `tail_channel.py`가 큐를 따라가 핸들러를 돌립니다. PC 쪽을 안 띄우면 호출이 쌓이기만 합니다.

### 1. 파일 복사

이 저장소의 `pc-bridge-mac/`이 배포 원본입니다. PC의 `$HOME/.naver-bridge/bridge/`로 복사합니다 (전체 경로 예시):

```sh
# 저장소 위치 (예: /Users/kwak/orca/workspaces/papercompany-plugins/pc-bridge)
REPO=/Users/kwak/orca/workspaces/papercompany-plugins/pc-bridge
mkdir -p $HOME/.naver-bridge/bridge/state
cp -r $REPO/pc-bridge-mac/bridge_server.py $REPO/pc-bridge-mac/handlers $REPO/pc-bridge-mac/pc-bridge-tunnel.sh $HOME/.naver-bridge/bridge/
cp $REPO/pc-bridge-mac/tail_channel.py $HOME/.naver-bridge/
chmod +x $HOME/.naver-bridge/bridge/handlers/*
# 실제 전체 경로: $HOME/.naver-bridge/bridge/bridge_server.py, $HOME/.naver-bridge/tail_channel.py
```

### 2. 키 설정 (서버와 PC가 같은 키)

```sh
echo 'PC_BRIDGE_KEY=여기에_긴_랜덤_문자열' > $HOME/.naver-bridge/bridge/state/bridge.env
chmod 600 $HOME/.naver-bridge/bridge/state/bridge.env
# 실제 전체 경로: $HOME/.naver-bridge/bridge/state/bridge.env
# 보드 플러그인 설정에도 같은 값을 webhookKey(또는 webhookKeyRef)로 넣기
# 보드 플러그인 설정에도 같은 값을 webhookKey(또는 webhookKeyRef)로 넣기
```

같은 키가 **서버 플러그인 설정**과 **PC `$HOME/.naver-bridge/bridge/state/bridge.env`**에 있어야 인증이 됩니다.

### 3. 핸들러 추가

`$HOME/.naver-bridge/bridge/handlers/<이름>` (전체 경로 예: `/Users/kwak/.naver-bridge/bridge/handlers/my-handler`)에 실행 파일을 만들면 됩니다. 규약:
- 파일명: `[a-z0-9-]` 1~64자, 실행 비트 필요 (`chmod +x`)
- 실행: `STDIN`으로 `params` JSON을 받고, `STDOUT` 마지막 줄에 `{"ok":bool,"message":...}` JSON 한 줄을 출력
- 예: `handlers/naver-publish`, `handlers/echo-test` 참조

### 4. 터널 + tail 채널 띄우기

```sh
# 터널: 서버의 127.0.0.1:8930을 PC의 127.0.0.1:8930으로 연결 (기본 서버 호스트는 환경변수로 지정)
PC_BRIDGE_SSH_HOST=your-server.example.com bash $HOME/.naver-bridge/bridge/pc-bridge-tunnel.sh &
# 전체 경로: $HOME/.naver-bridge/bridge/pc-bridge-tunnel.sh
# tail 채널: 서버 큐를 따라가 핸들러 실행 (LaunchAgent로 항상 켜두기 권장)
# 전체 경로: $HOME/.naver-bridge/tail_channel.py
# LaunchAgent: $HOME/Library/LaunchAgents/com.papercompany.pc-bridge.plist 가 tail_channel.py를 KeepAlive로 실행
launchctl load $HOME/Library/LaunchAgents/com.papercompany.pc-bridge.plist
```

다른 서버에 붙이려면 `PC_BRIDGE_SSH_HOST`와 `PC_BRIDGE_QUEUE` 환경변수로 서버 호스트·큐 경로를 지정하면 됩니다. 기본값은 기존 배포 호환용으로 유지됩니다.

### 5. 확인

```sh
# PC 로컬 직접 호출 (전체 경로: http://127.0.0.1:8930/dispatch)
curl -s http://127.0.0.1:8930/dispatch -H 'X-Papercompany-Webhook-Key: <키>' -d '{"handler":"echo-test","params":{"msg":"hi"}}'
# → {"ok":true,"message":"echo"}
# 서버 큐로 호출 (서버 전체 경로: /srv/papercompany/state/naver-publish-queue/pending.jsonl)
echo '{"handler":"echo-test","params":{"msg":"hi"}}' >> /srv/papercompany/state/naver-publish-queue/pending.jsonl
# PC 로그: $HOME/.naver-bridge/bridge/state/tail-channel.log 에 job received / job done 기록
```
# → PC tail 로그에 job received / job done 기록
```

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
