# pc-bridge 플러그인 구현 지시서 (Papercompany "PC 연결 지시" 브리지)

## 배경/미션
Papercompany에서 Linux 서버(A1)가 실행할 수 없는 자동화(예: 네이버 블로그 브라우저 발행)를
운영자 PC에 지시하기 위한 브리지 플러그인을 이 모노레포에 추가한다.
**동일한 브리지 서버가 이미 맥에서 가동 중**이며 실측 검증을 마쳤다:
- 맥 측 수신부: `http://127.0.0.1:8930/naver-publish` (A1의 SSH 역방향 터널 -R로 A1 루프백 8930에 노출)
- 프로토콜: `POST /naver-publish` 헤더 `X-Papercompany-Webhook-Key` + JSON `{"url", "workflow"|"category"}`
  → 응답 `{"ok", "message", "url"(발행 퍼머링크), "category", "title", "image_count"}`. 실패 시 `{"ok":false,"error","message"}`
- `GET /health` → `{"ok":true}`
- 구현 참고: `~/Projects/ai/papercompany/papercompany-operations/scripts/pc-bridge/` (읽기 참조만 가능, 수정 금지)

이번 작업: 이 모노레포에 `packages/pc-bridge/` 플러그인을 추가해, A1 워크플로우/툴이
"PC 브리지로 발행 지시"를 표준 방식으로 할 수 있게 하고, 운영자가 상태를 볼 수 있는 UI를 제공한다.

## 작업 규칙
- `packages/pc-bridge/` 안에서만 작업. **git commit/push 금지.**
- 이 모노레포의 기존 플러그인 2개(`packages/service-request-bridge`, `packages/github-repository-bridge`)의
  manifest/worker/UI/테스트/빌드 컨벤션을 **먼저 읽고 그대로 따른다**.
- SDK(`@paperclipai/plugin-sdk`) README도 읽고, 워커가 실제로 가진 기능(이벤트/라우트/config/API) 범위 안에서 설계한다.
  내가 요구하는 것과 SDK 실제 능력이 다르면 SDK 능력에 맞추고, 무엇을 어떻게 달성했는지 보고에 명시한다.

## 요구사항
1. **플러그인 ID**: `pc-bridge`. 패키지명은 이 모노레포 컨벤션 따름.
2. **발행 지시 전달**: A1(서버)에서 호출 가능한 형태로 "publish 지시"를 받아 맥 브리지로 전달한다.
   - 맥 브리지 주소는 config로: 기본 `http://127.0.0.1:8930` (SSH -R 터널이 A1 루프백에 연결해 줌)
   - 웹훅 키는 config/시크릿에서 읽고 코드에 하드코딩 금지
   - 전달 시 헤더 `X-Papercompany-Webhook-Key` + JSON 그대로 프록시, 응답도 그대로 반환
   - A1에서 호출하는 방법은 SDK가 지원하는 것이면 무엇이든 좋다(워커 HTTP 라우트가 안 되면 회사 툴/이벤트 등).
     최종 보고에 "A1이 이 플러그인을 호출하는 정확한 방법"을 명시할 것.
3. **검증**: url 화이트리스트(https + 호스트 `manual-onboarding.pages.dev`, `gazua.showk.ing`),
   workflow 6종 매핑(tech-ai-news=AI뉴스, tech-ai-scout=AI소프트웨어, agent-team-concept-radar=AI개념,
   youtube-report=AI유투브요약, gazua-morning=한국증시, gazua-evening=미국증시), category 직접지정은 위 6개만.
4. **상태 UI(page)**: 맥 브리지 /health 상태, 최근 발행 이력(가능하면), 수동 발행 폼(url+워크플로 선택).
   이 모노레포 UI 컨벤션(다른 플러그인 ui/index.tsx)을 따른다.
5. **테스트**: 기존 플러그인 테스트 컨벤션 따라 — 검증/매핑/프록시(모킹) 케이스.

## 완료 조건
1. `pnpm install` 후 `pnpm --filter <pkg> typecheck && pnpm --filter <pkg> test && pnpm --filter <pkg> build` 전부 통과.
2. 최종 보고: 변경 파일 목록, 테스트 출력, "A1 호출 방법" 명시, 못한 것 목록.
3. git commit/push 금지 (컨트롤러가 검수 후 커밋).
