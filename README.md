# AI_ChatterBox

채팅 하나에 지시하면 **마스터**가 계획을 세우고, 일의 양에 맞춰 **클로드 N호**(Claude Code)와 **지피티 N호**(Codex) 작업자를 꾸려 구현과 리뷰를 나눠 맡기는 Windows 데스크톱 앱입니다 (Electron + React + TypeScript).

![GPT 오케스트레이터가 GPT에 구현, Claude에 리뷰를 맡긴 화면](docs/screenshots/v2-fix-gpt.png)

- **프로젝트 = 작업 폴더.** 프로젝트 아래에 채팅이 있고, 각 채팅을 펼치면 `마스터 대화 · 클로드 1호 · 클로드 2호 · 지피티 1호 … · 협의 N (보낸 쪽 → 받는 쪽)`이 트리로 보입니다.
- **작업자 팀 (0.3):** 마스터가 필요한 만큼 작업자를 만들고(`spawn`) 닉네임으로 일을 맡깁니다(`ask`). 고칠 범위(scope)가 겹치지 않는 구현과 리뷰는 동시에 진행되고, 작업자끼리도 닉네임으로 서로 묻습니다. 범위 밖 쓰기는 자동 거부, 서로 기다리는 순환 호출은 거절됩니다. 동시에 클로드 3명 + 지피티 3명까지(프로젝트 설정).
- **슬래시 명령 (0.3):** `/plan`(계획 → 실행/수정/취소), `/goal`(목표를 끝날 때까지 진행), `/review`, `/status`, `/model`, `/new`, `/stop`, `/compact`.
- **세 역할, 세 모델.**
  - **마스터:** 지시를 받아 계획·구현하고 작업자에게 일을 맡깁니다. 작은 수정은 직접 처리하며 작업자 구현과 동시에 직접 변경하지 않습니다. Claude 모델을 고르면 Claude Code로, GPT 모델을 고르면 Codex로 실행됩니다.
  - **클로드 N호 / 지피티 N호:** 실제로 파일을 고칩니다. 각자 자기 세션을 가지고, 맡은 범위 안에서만 고칩니다.
  - **모델 설정:** 마스터·클로드·지피티 모델을 프로젝트마다 정하고, 채팅 상단에서 채팅별로 바꿀 수 있습니다. 목록에는 계열별 최신 모델만 보입니다.
- **협업 흐름:** 계획 → 작업자 구성 → 범위를 나눠 구현 → 다른 작업자가 리뷰 → 수정 → 최종 보고. 협의는 채팅 안에 카드로 실시간 표시됩니다 (예: "마스터 → 클로드 2호 · 구현 · src/ui/**").
- **승인:**
  - **적용 대상:** 마스터와 작업자의 파일 수정·명령 실행에 같은 프로젝트 승인 설정을 적용합니다. 자동 승인은 별도의 판단 세션이 맡고, 실패·시간 초과·추가 결정이 필요하면 사용자 카드로 돌아옵니다.
  - **카드 버튼:** 직접 승인에서는 **이번만 허용 / 이 채팅 동안 허용 / 거부** 중에서 고릅니다. 고위험 요청은 채팅 전체 허용을 기억하지 않습니다.
  - **고위험 위임:** 설정을 켜면 판단 세션이 사용자 지시 범위 안의 고위험 요청도 허용·거부할 수 있습니다. 설정 변경은 이전 승인 기억을 초기화합니다. `/plan`과 리뷰·의견의 수정 금지는 계속 적용됩니다.
  - **위험 우회 플래그 안 씀:** `--dangerously-skip-permissions`나 Codex yolo 모드는 쓰지 않습니다.
- **첨부:** 📎 버튼, **Ctrl+V** 이미지 붙여넣기, 끌어다 놓기를 지원합니다. 이미지는 Claude와 Codex 모두 직접 봅니다.
- **진행 중 조작:** 작업 중에도 추가 지시를 보낼 수 있고 (다음 단계에 오케스트레이터에게 전달), **중지**를 누르면 두 에이전트가 모두 멈춥니다.
- **그 밖의 기능:** 마크다운과 코드 하이라이트, 도구 호출 카드, diff 보기, 다크/라이트 테마, 사용량 표시(Claude 5시간 / Codex 5시간·주간), 채팅과 메시지 검색, 창 크기 기억.
- **작업자 가로줄 (0.3.1):** 상단 메뉴 아래에 생성된 작업자를 표시합니다. 활성 작업자가 앞에, 회색으로 표시한 해제 작업자는 뒤쪽 별도 구역에 있으며 모두 기록을 열 수 있습니다.
- **캐릭터 (0.3.1):** 무광 눈동자와 같은 치비 화풍으로 맞춘 마스터·클쨩·짚쨩의 12종 표정을 표시합니다. `set_expression(expression)`은 호출한 역할의 다음 대사에 연결되고 과거 대사의 표정은 보존합니다. 실제 작업·승인·오류 상태는 별도 배지로 표시합니다. [표정 갤러리](docs/character-gallery.html)와 [제작 기준](docs/character-art.md)을 보관합니다.

## 필요한 것

- Windows 10/11
- **Claude Code** (독립 설치본, 로그인된 상태)
  - 설치: PowerShell에서 `irm https://claude.ai/install.ps1 | iex` → `%USERPROFILE%\.local\bin\claude.exe`
  - 로그인: `& "$env:USERPROFILE\.local\bin\claude.exe"` 실행 후 `/login`
  - Claude 데스크톱 앱 안에 있는 사본은 쓰지 않습니다. 업데이트 때마다 경로가 바뀌고 앱 밖에서는 로그인이 안 돼 있습니다.
- **Codex** (Codex 앱 또는 Codex CLI, 로그인된 상태). 앱은 다음 순서로 찾습니다.
  1. `%LOCALAPPDATA%\OpenAI\Codex\bin\<ver>\codex.exe`
  2. PATH
  3. `~\.codex\packages\standalone\releases`

## 실행 파일

`dist\AI_ChatterBox-0.3.1-portable.exe`를 더블클릭하면 됩니다. 설치는 필요 없습니다.

- 실행할 때마다 임시 폴더에 압축을 풀기 때문에 처음 창이 뜰 때까지 10초쯤 걸립니다.
- 실행기와 내부 앱 모두 Windows 관리자 권한을 요청합니다. UAC를 취소하면 실행되지 않습니다. CLI의 쓰기·명령 승인은 Windows 권한과 별도로 적용됩니다.
- 서명하지 않은 exe라서 처음 실행할 때 SmartScreen이 막으면 **추가 정보 → 실행**을 누르세요.
- 데이터는 `%APPDATA%\AI_ChatterBox`에 저장됩니다.
  - `chatterbox.db`: 프로젝트, 채팅, 협의, 이벤트
  - `attachments\`: 첨부 파일
  - 원본 대화 기록은 각 CLI가 원래 두는 곳(`~\.claude`, `~\.codex`)에 그대로 있습니다.
- v0.1 데이터가 있으면 처음 실행할 때 "가져온 세션" 프로젝트로 옮겨집니다.

## 개발

관리자 PowerShell에서 개발 실행합니다. 일반 권한에서 실행한 개발 앱과 자식 CLI는 관리자 작업을 수행할 수 없습니다.

```powershell
npm install
npm run dev
```

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | 개발 모드 (렌더러 핫 리로드) |
| `npm run build` 후 `npm start` | 빌드 결과로 실행 |
| `npm run typecheck` | 타입 검사 |
| `npm test` | 승인·계획/리뷰·범위·표정 단위 검사 |
| `npm run test:ui` | 격리 데이터로 설정창·작업자·재실행 UI 검사 (모델 호출 없음) |
| `node scripts/smoke-cli-permissions.mjs` | 실제 Claude/Codex 마스터·작업자의 수정·명령·승인·표정 검사 (사용량 발생) |
| `node scripts/smoke-cli-restrictions.mjs` | 실제 CLI의 계획·리뷰 제한, 별도 판단 세션의 고위험 위임 분기 검사 (사용량 발생) |
| `node scripts/verify-character-assets.mjs` | 36개 PNG의 크기·투명도 검사와 표정 갤러리 캡처 |
| `pwsh -File scripts/verify-admin-manifest.ps1 -Paths dist/AI_ChatterBox-0.3.1-portable.exe` | 배포 실행기의 requireAdministrator 매니페스트 검사 |
| `node scripts/smoke-admin.mjs` | 격리 데이터로 UAC 실행·자식 CLI 관리자 토큰·관리자 조회 명령 검사 (직접 UAC 확인 필요, 사용량 발생) |
| `npm run dist` | `dist\AI_ChatterBox-<버전>-portable.exe` 만들기 |
| `npm run codex:schema` | 설치된 codex 버전으로 `src/main/codex-schema` 다시 만들기 |
| `node scripts/e2e-v1.mjs` | 화면·구조 검사: 트리, 첨부 3가지, 이미지 이해, 마크다운, 모델 상속, 재실행 |
| `node scripts/e2e-v2.mjs [A B C D]` | 협업 검사: Claude/GPT 오케스트레이터로 버그 수정 → 교차 리뷰, 한도, 중지 |
| `node scripts/e2e-v3.mjs` | 마무리 검사: exe로 시나리오 재현, 재실행 후 이어서 지시, v1 이전, 검색, 오케스트레이터 전환 |

e2e는 진짜 CLI를 쓰므로 사용량이 듭니다. 데이터는 `.scratch\`에 따로 만듭니다. `E2E_EXE`에 exe 경로를 주면 패키징한 앱으로 검사합니다.

### 0.3.1 검증 기록 (2026-10-13)

| 구분 | 결과와 범위 |
|---|---|
| 정적·단위 검사 | 타입 검사, 단위 검사 50개 통과. 설정 변경에 따른 승인 기억 무효화, 범위 재검사, 동시 구현 제한, 재실행 후 계획/리뷰 제한, 표정 귀속 포함 |
| 격리 UI | 19개 통과. 두 스위치 반복 조작, 취소·저장·실패·재실행, 작업자 구역·해제·기록 열기·가로 스크롤, 다크/라이트 포함 |
| 이미지 | 36개 모두 1254×1254 RGBA와 실제 투명도 확인. 갤러리에서 표정·무광 눈동자·작은 크기 표시 확인 |
| 실제 CLI 직접 승인 | Claude와 Codex 각각 마스터·작업자의 파일 생성·편집·명령과 표정 브리지 확인. Write/Edit 및 apply_patch 경로 포함 |
| 실제 CLI 자동 판단 | Claude와 Codex 마스터·작업자 16개 검사 통과. 별도 판단 세션을 거쳐 파일 생성·편집 |
| 실제 CLI 수정 제한·판단 분기 | 10개 검사 통과. `/plan`·리뷰는 수정하지 않았고, 고위험 위임 끄기는 사용자 카드로 복귀, 켜기는 명시된 테스트 대상 허용. 폴더 밖 쓰기는 판단만 검사하고 실제 실행하지 않음 |
| 관리자 실행 | 내부 앱·포터블 실행기의 requireAdministrator 매니페스트 확인. UAC 승인 후 포터블 후보에서 Claude·Codex 마스터 자식 프로세스 각각 관리자 토큰=true, 관리자 조회 fltmc 종료 코드=0 확인. UAC 취소 동작은 실측하지 않음 |

실제 CLI 검사는 기존 로그인으로 격리 작업 폴더에서 실행했습니다. 기존 앱 데이터는 수정하지 않았습니다. 관리자 검사는 시스템을 변경하지 않는 조회 명령만 실행했습니다. 그림을 포함해 재패키징한 최종 파일은 매니페스트를 다시 검사합니다. UAC 취소 동작과 모든 종류의 관리자 작업까지 검증한 것은 아닙니다.

권한 설정 참고: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude Code permissions](https://code.claude.com/docs/en/permissions), [Electron Windows 설정](https://www.electron.build/docs/api/app-builder-lib.interface.windowsconfiguration/), [Portable 설정](https://www.electron.build/docs/api/app-builder-lib.interface.portableoptions/).

## 구조

```
src/main/
  index.ts            창, IPC, cbx:// 첨부 미리보기, 종료 시 CLI 정리
  chats.ts            채팅별 세 역할(orch/claude/gpt) 드라이버, 상태, 이벤트 저장·전달
  orchestrator.ts     협업 엔진: 마스터 + 작업자 풀 (spawn/ask/release/agents/checklist/update_goal/ask_user), 병렬·범위 잠금, 한도, 추가 지시, 중지, 슬래시 명령
  scope.ts, team.ts   범위 glob 검사, 교착(순환)·깊이 방지
  judge.ts            자동 승인 판단 (마스터 모델로 도는 도구 없는 대화)
  instance-guard.ts   같은 데이터 폴더로 두 번 실행 방지 (0.2.0 포함)
  tray.ts             트레이, 알림, 종료 확인
  local-bridge.ts     CLI가 띄운 MCP 서버가 부르는 로컬 HTTP (127.0.0.1 + 토큰)
  bridge-mcp.ts       claude.exe / codex.exe가 불러 쓰는 stdio MCP 서버 (별도 번들)
  approvals.ts        승인 정책: 위험도 분류, "이 채팅 동안 허용" 기억
  drivers/claude.ts   claude -p stream-json 장기 실행 프로세스 (--resume, 이미지 블록, 모델 목록)
  drivers/codex.ts    codex app-server (thread/start·resume, turn/start, 승인, localImage)
  db.ts               SQLite (Electron 내장 node:sqlite), v1 데이터 이전
  attachments.ts      첨부 파일 보관
src/renderer/         React + Tailwind + Radix UI
docs/design-v2.md     설계
spike/                M0 기술 검증
```
