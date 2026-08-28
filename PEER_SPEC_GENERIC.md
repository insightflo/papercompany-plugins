# pc-bridge 범용화 리팩터 지시서 (네이버 전용 → 범용 PC 기능 호출 브리지)

## 미션
pc-bridge를 "네이버 발행 전용"에서 **"운영자 PC의 등록된 기능(핸들러)을 호출하는 범용 브리지"**로 리팩터한다.
호출-연결(전달·검증·기록)만 플러그인/브리지가 담당하고, 기능별 지식(카테고리 매핑·호스트 검증 등)은
호출자(워크플로우)와 PC 측 핸들러가 담당한다. 네이버 발행은 핸들러 1종이 된다.

## 작업 위치
- 이 워크트리 `packages/pc-bridge/` (플러그인) — 기존 파일 수정
- Mac 브리지 참조 구현은 `/Users/kwak/.naver-bridge/` 와 `/Users/kwak/orca/workspaces/papercompany-operations/pc-bridge/scripts/pc-bridge/` (읽기 참조, 수정 대상은 이 워크트리의 `pc-bridge-mac/` 신규 디렉터리로 복사해 리팩터)
- 금지: git commit/push, 워크트리 밖 수정

## 큐·호출 계약 (범용)
```
큐 줄 / HTTP 바디: {"handler": "<핸들러명>", "params": {객체}}
```
- handler는 Mac의 `handlers/` 디렉터리에 실행 파일로 등록된 것만 허용 (디렉터리 화이트리스트 — 임의 명령 실행 금지)
- 각 핸들러가 자기 params를 검증한다. 실패 시 `{"ok":false,"error":...}` JSON 반환.
- 결과는 마지막 줄 JSON: `{"ok":bool, "message":..., ...}`

## 작업 목록

### A. Mac 브리지 리팩터 (이 워크트리의 `pc-bridge-mac/` — operations repo 배포용 사본)
`/Users/kwak/orca/workspaces/papercompany-operations/pc-bridge/scripts/pc-bridge/` 의
bridge_server.py·naver_handler.py·tests 를 `pc-bridge-mac/` 으로 복사한 뒤 리팩터:
1. **핸들러 디스패치**: `handlers/<이름>` 실행 파일 존재 검사 → 서브프로세스로 실행,
   params는 stdin으로 JSON 전달. 결과는 stdout 마지막 줄 JSON. 타임아웃 480초.
2. **HTTP 엔드포인트**: `POST /dispatch {"handler","params"}` (키 인증·중복차단·레이트리밋·감사로그 유지).
   구 `/naver-publish`는 별칭으로 유지(호환).
3. **handlers/naver-publish**: 기존 naver_handler.py 로직을 이동. params {url, workflow|category} 검증
   (url https + 호스트 manual-onboarding.pages.dev|gazua.showk.ing, workflow 6종→카테고리 매핑)은 핸들러 내부에 유지.
4. **handlers/README.md**: 핸들러 추가 방법 (실행 파일 규약: stdin JSON params → stdout 마지막 줄 JSON 결과, exit code).
5. tests: 디스패치·핸들러 미발견·params 오류 케이스로 갱신. 전부 통과해야 함.

### B. 플러그인 리팩터 (packages/pc-bridge/)
1. **툴 단순화**: `pc-bridge-dispatch` — 파라미터 `{handler: string, params: object}`.
   네이버 전용 검증(카테고리 매핑·호스트 화이트리스트)을 플러그인에서 **제거**(핸들러 책임으로 이동).
   전달 전 검증은 handler 이름이 `[a-z0-9-]` 형식인 것과 params가 객체인 것만.
2. **웹훅**: `/webhooks/dispatch` — 동일 바디, fire-and-forget.
3. **UI**: 수동 발행 폼(네이버 전용) 제거 → **범용 디스패치 폼**(handler 이름 + params JSON)과
   최근 디스패치 이력, 체인 구조 문서(큐 방식 설명)로 교체. 건강검진(health) 표기는
   "브리지가 SSH 터널 루프백 뒤에 있어 플러그인에서 직접 확인 불가"로 정직하게 표기.
4. **문서**: README에 범용 설계 명시 — "핸들러는 PC에 추가하고, 호출은 {handler, params} 하나로."
   네이버 발행은 예시 핸들러임을 명시.

### C. 검증
1. 플러그인: `pnpm --filter @insightflo/paperclip-pc-bridge typecheck && test && build` 전부 통과.
2. Mac: `python3 pc-bridge-mac/tests/...` unittest 전부 통과.
3. E2E 스모크(로컬): bridge 기동 → /dispatch {"handler":"echo-test",...} → handlers/echo-test 더미로 검증.

## 보고
변경 파일, 테스트 출력, A1 호출 방법(웹훅/툴), 못한 것 목록.
