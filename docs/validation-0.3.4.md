# AI_ChatterBox 0.3.4 검증 기록

검증일: 2026-10-14. 기존 실행 중인 사용자 ChatterBox와 데이터는 유지했다. 테스트는 새 임시 작업 폴더와 SQLite를 사용했다.

## 자동 검사

- Node·Web TypeScript와 프로덕션 빌드: 통과.
- 단위 검사: **104/104**. 기존 승인·범위·작업자 정책에 더해 Gemini 모델 필터, 쓰기·리뷰 승인, MCP 제한, 중지 중 승인 거부, 늦은 프로세스 종료 이벤트, 실행 준비 중 중지, 재개 토큰 차이와 기존 DB 마이그레이션을 검사했다.
- 협의·링크·승인·사용량 UI: **50/50** (`scripts/e2e-delegation-ui.mjs`). 기존 동작 유지.
- Gemini UI: 최종 **18/18** (`scripts/e2e-gemini-ui.mjs`). 고정 데이터로 모델 설정, 활성/해제 표시, 사용량과 기록 재실행을 검사했다. 이 화면 검사는 실제 모델 성능 측정이 아니다.
- 설정·작업자 UI: **22/22** (`scripts/e2e-settings-workers.mjs`). 두 스위치, 취소·저장 실패·재실행, 넓은 설정창, 좁은 창에서 가로 넘침 없음, 모든 작업자 입력칸의 크기 조절 표시 제거를 검사했다. 다크·라이트 화면을 확인했다. 증거: `.scratch/ui-verification/1791942635958/screenshots`.

## 실제 Google AI Pro CLI

공식 Antigravity CLI 1.3.4 설치와 Google 계정 브라우저/터미널 로그인을 완료했다. 계정의 `agy models` 결과는 Gemini 3.8 Flash High·Medium·Low였으며 Medium으로 검증했다. API 키, Ultra 전환, 추가 크레딧 구매는 사용하지 않았다.

`scripts/smoke-gemini.mjs`: **10/10**. 실제 파일 FIRST 생성 → SECOND 수정 → 읽기, 기본 명령 실행, 앱 승인 전달, 거부한 파일 미생성, 표정 MCP, 저장한 native ID로 대화 재개, 누적 토큰 중복 제외를 확인했다. 증거: `%TEMP%/chatterbox-gemini-smoke-1791942243650/result.json`.

`scripts/smoke-gemini-master.mjs`: 실제 **Claude Sonnet / Codex gpt-6.1-sol** 마스터에게 요청을 전달해 각각 Gemini 작업자 한 명 생성 → 파일 읽기·계산 → 응답 → 마스터 취합 → 해제를 확인했다. 각 7개 검사 통과. 테스트 코드가 직접 `spawn`/`ask`를 호출한 결과가 아니다.

- Codex 증거: `%TEMP%/chatterbox-gemini-master-1791941552811/results.json`의 Codex 7건.
- Claude 증거: `%TEMP%/chatterbox-gemini-master-1791941862918/results.json`의 Claude 7건. 초기 문구의 “alpha와 beta 합계”가 항목별 합계로 해석되어, 재검사에서는 “두 수를 더한 하나의 총합”으로 명시했다.

초기 실제 실행에서 발견한 Windows hook 인용 처리, MCP wrapper 도구명, 대화 재개 누적 사용량, 이전 프로세스의 지연 종료 처리를 수정했다. 모델 목록의 일시적 조회 실패는 로그인 실패와 구분하고 동시에 들어오는 요청을 짧게 공유한다. 실제 실행에서 확인한 승인 거부와 자동 검사에서 확인한 리뷰·중지 정책은 구분한다.

## 포터블 배포

- 파일: `dist/AI_ChatterBox-0.3.4-portable.exe` (150,350,182 bytes).
- SHA-256: `0F56FAF8A6B18B51D55535B9C898FBFE67B29E82822AED51504BF05A4118B185`.
- 실행기와 내부 `AI_ChatterBox.exe`의 `requireAdministrator` 매니페스트 검사 통과.
- 패키지 버전 0.3.4 확인. `out`의 135개 파일이 패키지 내용과 일치하며, 별도 실행해야 하는 `antigravity-hook.js`의 압축 해제 위치와 파일 해시를 확인했다.
- 기존 작업을 유지하기 위해 실행 중인 사용자 앱을 종료하거나 교체하지 않았다. 이번 빌드의 실제 UAC 클릭·관리자 자식 프로세스 검사는 다시 수행하지 않았다.

## 범위와 제한

Gemini 마스터·이미지 생성·계정 잔여 한도 표시는 추가하지 않았다. Gemini 원본 대화의 자동 보관 API는 미연결이다. CLI 제어 폴더의 `AI AGENT` 분리는 Antigravity 앱의 네이티브 프로젝트 생성과 같지 않다. 모든 모델·한도·네트워크 장애·실제 UAC 조합을 실행한 결과는 아니다. Windows 토스트와 장비 연결은 이번 검증 대상이 아니다.

사용법과 공식 문서: [Google AI Pro 설정](gemini-pro.md).
