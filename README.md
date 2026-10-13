# AI_ChatterBox

채팅 하나에 지시하면 **오케스트레이터**가 계획을 세우고 **Claude**(Claude Code)와 **GPT**(Codex)에게 구현과 리뷰를 나눠 맡기는 Windows 데스크톱 앱입니다 (Electron + React + TypeScript).

![GPT 오케스트레이터가 GPT에 구현, Claude에 리뷰를 맡긴 화면](docs/screenshots/v2-fix-gpt.png)

- **프로젝트 = 작업 폴더.** 프로젝트 아래에 채팅이 있고, 각 채팅을 펼치면 `오케스트레이터 대화 · Claude 대화 · GPT 대화 · 협의 N`이 트리로 보입니다.
- **세 역할, 세 모델.**
  - **오케스트레이터 (읽기 전용):** 지시를 받아 계획하고 작업자에게 일을 맡깁니다. Claude 모델을 고르면 Claude Code로, GPT 모델을 고르면 Codex로 실행됩니다.
  - **Claude 작업자 / GPT 작업자:** 실제로 파일을 고칩니다. 한 번에 한 작업자만 고칩니다.
  - **모델 설정:** 세 모델 모두 프로젝트마다 정합니다. 채팅 상단에서 작업자 모델만 채팅별로 바꿀 수 있습니다.
- **협업 흐름:** 계획 → 한 작업자에게 구현 위임 → 다른 작업자에게 리뷰 → 수정 → 최종 보고. 협의는 채팅 안에 카드로 실시간 표시됩니다 (예: "오케스트레이터 → GPT · 구현").
- **승인:**
  - **카드 버튼:** 작업자가 파일을 고치거나 명령을 실행하려 하면 카드가 뜹니다. **이번만 허용 / 이 채팅 동안 허용 / 거부** 중에서 고릅니다.
  - **항상 매번 묻는 작업:** 작업 폴더 밖 경로, 삭제, `git push`, 자격 증명 파일 접근은 "이 채팅 동안 허용"이 막혀 있어서 매번 묻습니다.
  - **위험 우회 플래그 안 씀:** `--dangerously-skip-permissions`나 Codex yolo 모드는 쓰지 않습니다.
- **첨부:** 📎 버튼, **Ctrl+V** 이미지 붙여넣기, 끌어다 놓기를 지원합니다. 이미지는 Claude와 Codex 모두 직접 봅니다.
- **진행 중 조작:** 작업 중에도 추가 지시를 보낼 수 있고 (다음 단계에 오케스트레이터에게 전달), **중지**를 누르면 두 에이전트가 모두 멈춥니다.
- **그 밖의 기능:** 마크다운과 코드 하이라이트, 도구 호출 카드, diff 보기, 다크/라이트 테마, 사용량 표시(Claude 5시간 / Codex 5시간·주간), 채팅과 메시지 검색, 창 크기 기억.

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

`release\AI_ChatterBox-0.2.0-portable.exe`를 더블클릭하면 됩니다. 설치는 필요 없습니다.

- 실행할 때마다 임시 폴더에 압축을 풀기 때문에 처음 창이 뜰 때까지 10초쯤 걸립니다.
- 서명하지 않은 exe라서 처음 실행할 때 SmartScreen이 막으면 **추가 정보 → 실행**을 누르세요.
- 데이터는 `%APPDATA%\AI_ChatterBox`에 저장됩니다.
  - `chatterbox.db`: 프로젝트, 채팅, 협의, 이벤트
  - `attachments\`: 첨부 파일
  - 원본 대화 기록은 각 CLI가 원래 두는 곳(`~\.claude`, `~\.codex`)에 그대로 있습니다.
- v0.1 데이터가 있으면 처음 실행할 때 "가져온 세션" 프로젝트로 옮겨집니다.

## 개발

```powershell
npm install
npm run dev
```

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | 개발 모드 (렌더러 핫 리로드) |
| `npm run build` 후 `npm start` | 빌드 결과로 실행 |
| `npm run typecheck` | 타입 검사 |
| `npm run dist` | `dist\AI_ChatterBox-<버전>-portable.exe` 만들기 |
| `npm run codex:schema` | 설치된 codex 버전으로 `src/main/codex-schema` 다시 만들기 |
| `node scripts/e2e-v1.mjs` | 화면·구조 검사: 트리, 첨부 3가지, 이미지 이해, 마크다운, 모델 상속, 재실행 |
| `node scripts/e2e-v2.mjs [A B C D]` | 협업 검사: Claude/GPT 오케스트레이터로 버그 수정 → 교차 리뷰, 한도, 중지 |
| `node scripts/e2e-v3.mjs` | 마무리 검사: exe로 시나리오 재현, 재실행 후 이어서 지시, v1 이전, 검색, 오케스트레이터 전환 |

e2e는 진짜 CLI를 쓰므로 사용량이 듭니다. 데이터는 `.scratch\`에 따로 만듭니다. `E2E_EXE`에 exe 경로를 주면 패키징한 앱으로 검사합니다.

## 구조

```
src/main/
  index.ts            창, IPC, cbx:// 첨부 미리보기, 종료 시 CLI 정리
  chats.ts            채팅별 세 역할(orch/claude/gpt) 드라이버, 상태, 이벤트 저장·전달
  orchestrator.ts     협업 엔진: consult_claude / consult_codex / ask_user, 한도, 추가 지시, 중지
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
