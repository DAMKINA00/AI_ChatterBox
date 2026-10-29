# 원격 웹 기능 확장 설계 (ai.damkina.net)

작성: 2026-10-29 · 대상 브랜치 `feature/remote-web` (v0.4.36) · 단계: 설계만(코드 변경 없음)

현재 원격 웹 기능: 채팅 목록·내용 조회, 실시간 갱신(SSE), 지시 전송(now/next), 중지, 승인·질문 답변.
조사 범위: `src/renderer/src/**`(데스크톱 UI), `src/preload/index.ts`, `src/shared/types.ts`(`ChatterBoxApi`), `src/main/core.ts`(코어 RPC 채널), `src/main/index.ts`(화면 프로세스 전용 채널).

---

## 1. 데스크톱 기능 전체 목록

`채널` = 코어 RPC 채널(`core.ts`) 또는 화면 프로세스 채널(`index.ts`). `UI` = 주 사용 위치.

| # | 기능 | 채널 / 함수 | UI |
|---|---|---|---|
| **채팅** ||||
| 1 | 채팅 목록 | `chats:list` → `store.listChats` | Sidebar |
| 2 | 새 채팅 만들기 | `chats:create(projectId)` → `store.createChat` | Sidebar 프로젝트 메뉴 "새 채팅" |
| 3 | 이름 변경 | `chats:update(id,{title})` | Sidebar "이름 변경" |
| 4 | 보관 / 보관 해제 | `chats:update(id,{archived})` | Sidebar "보관" |
| 5 | 삭제 | `chats:delete` → `orchestrator.stop`·`forget`·`chats.deleteChat` | Sidebar "삭제"(확인 대화상자) |
| 6 | 읽음 표시 | `chats:viewed` | 채팅 선택 시 자동 |
| 7 | 대화 내용·작업자·협의 조회 | `chats:events`·`chats:agents`·`chats:consults` | ChatView |
| 8 | 채팅 검색 | `chats:search(q)` | Sidebar 검색 |
| 9 | 지시 전송(새 지시 / 실행 중 now·next) | `chats:send` | Composer |
| 10 | 중지 | `chats:stop` | ChatView |
| 11 | 일시정지 / 재개 | `chats:pause` / `chats:resume` | ChatView |
| 12 | 이어서 진행(중단된 실행) / 알림 닫기 | `chats:resume` / `chats:dismissInterrupted` | ChatView 중단 배너 |
| 13 | 명령 `/plan` `/goal` `/review` `/compact`, 계획 실행·취소 | `chats:command(id,name,arg)` → `orchestrator.command`(plan, plan-run, plan-cancel, goal, review, compact, stop) | Composer, PlanGoal |
| 14 | 승인 응답(once/chat/deny) | `chats:approve` | Items 승인 카드 |
| 15 | 마스터 질문 답변 | `chats:answerAsk` | Items 질문 카드 |
| 16 | 채팅별 모델 지정(마스터·클로드·지피티·제미나이·그록·딥시크) | `chats:update(id,{*ModelOverride})` + `models:list(agent)` | ModelPicker |
| 17 | 채팅별 추론 수준 | `chats:update(id,{*EffortOverride})` | EffortPicker |
| 18 | 채팅별 승인 방식 | `chats:update(id,{approvalModeOverride})` | ChatView 메뉴 |
| **첨부·파일** ||||
| 19 | 파일 선택 대화상자로 첨부 | `att:pick`(화면 프로세스 `dialog.showOpenDialog`) → `att:paths` | Composer |
| 20 | 드래그·붙여넣기 첨부 | `att:paths`(로컬 경로) / `att:bytes`(바이트) | Composer |
| 21 | 첨부 제거 | `att:remove` | Composer |
| 22 | 첨부·이미지 보기 | `cbx://attachment/<id>`(protocol) / `artifacts:previewImage` | Items, ArtifactPreview |
| 23 | 파일 링크 열기·탐색기·다른 이름 저장 | `shell:link`, `shell:openPath`, `files:resolve-link` | FileLink, Items |
| **프로젝트** ||||
| 24 | 프로젝트 목록 | `projects:list` | Sidebar |
| 25 | 새 프로젝트(이름·폴더·설정) | `projects:pickFolder`(폴더 대화상자) + `projects:create` | ProjectDialog |
| 26 | 프로젝트 설정(모델·추론·강점/주의·리뷰 게이트·한도·작업자 수·승인 방식·계정 정책) | `projects:update(id,{settings})` | ProjectDialog |
| 27 | 프로젝트 이름 변경 / 폴더 변경 | `projects:update(id,{name|folder})` | Sidebar, ProjectDialog |
| 28 | 프로젝트 보관 / 해제 | `projects:update(id,{archived})` | Sidebar |
| 29 | 프로젝트 삭제 | `projects:delete` | Sidebar(확인) |
| 30 | 프로젝트 폴더 열기 | `shell:openPath` | Sidebar "폴더 열기" |
| **사용량·계정·연결** ||||
| 31 | 사용량·잔고 보기 / 새로고침 | `usage:get(wait)`, `cli:info` | UsageBar |
| 32 | CLI 계정 목록·로그인·로그아웃·추가·삭제·이름/사용 여부 | `cli-accounts:*` | CliAccountsDialog |
| 33 | 계정 정책(고정/자동) | `cli-accounts:get-policy` / `set-policy` | CliAccountPolicyField |
| 34 | Gemini 웹 계정(로그인 창·상태·추가·로그아웃) | `gemini:web`, `gemini:web-accounts` | GeminiWebDialog |
| 35 | AI Studio 설정·실행·계정 연결·사용 기록 | `aistudio`, `aistudio:usage` | AIStudioDialog, AIStudioUsage |
| 36 | DeepSeek API 키·확인·잔고 | `deepseek` | DeepSeekDialog |
| 37 | 원격 웹 접속 설정 | `remote-web`(화면 프로세스) | RemoteWebDialog |
| **앱** ||||
| 38 | 테마(다크/라이트) | `theme:get` / `theme:set` | App |
| 39 | 창 위치 저장, 트레이, 업데이트 설치, 사용량 모니터 | `window:save`, tray·`AppUpdates`·`UsageCompanion` | 트레이 메뉴 |

총 39개 항목입니다(원격 웹에 이미 있는 것: 1, 7, 9, 10, 14, 15).

---

## 2. 원격 허용 분류

기준
- 원격에서 **임의 파일 경로 선택, 로컬 파일시스템 탐색, 실행 파일·CLI 경로, API 키, 계정 로그인, 원격 웹 설정 자체 변경**은 C 또는 강하게 제한합니다.
- 파괴적 동작(삭제)은 서버가 확인값을 요구하는 B입니다.
- 원격 응답에서는 로컬 경로(`AttachmentRef.path`, 프로젝트 `folder`, CLI `path`, `configDir`)와 계정 이메일을 제거합니다.

| # | 기능 | 분류 | 근거·조건 |
|---|---|---|---|
| 1, 7, 9, 10, 14, 15 | (기존) 조회·전송·중지·승인·답변 | 기존 | 이미 구현됨. B-1(첨부 경로 제거)을 함께 적용 |
| 2 | 새 채팅 | **A** | 기존 프로젝트 id만 받음. 파일시스템 영향 없음 |
| 3 | 채팅 이름 변경 | **A** | 텍스트(최대 200자) |
| 4 | 채팅 보관 / 해제 | **A** | 되돌릴 수 있음 |
| 5 | 채팅 삭제 | **B** | 되돌릴 수 없음. 요청에 `confirm`=채팅 제목(정확히 일치)이 필요. 실행 중이면 409(먼저 중지) |
| 6 | 읽음 표시 | **A** | 내부 상태 |
| 8 | 채팅 검색 | **A** | 읽기 |
| 11 | 일시정지 / 재개 | **A** | 기존 중지와 같은 성격 |
| 12 | 이어서 진행 / 알림 닫기 | **A** | 데스크톱 배너와 같음 |
| 13 | 명령(plan, plan-run, plan-cancel, goal, review, compact) | **A** | 허용 목록에 있는 이름만, `arg` ≤ 50,000자. `stop`은 기존 중지 API 사용 |
| 16 | 채팅별 모델 지정 | **A** | `models:list`가 돌려준 id만 허용(서버가 검증) |
| 17 | 채팅별 추론 수준 | **A** | 모델의 `reasoningEfforts` 또는 `auto`/빈 값 |
| 18 | 채팅별 승인 방식 | **B** | 원격에서 자율성을 높이는 변경(`orchestrator-all` 등)은 `confirm: true`를 요구하고 기록. 결정 필요 D3 |
| 19 | 파일 선택 대화상자 첨부 | **C** | PC에 대화상자가 뜨고 로컬 경로를 다룸 |
| 20 | 첨부 업로드 | **B** | 브라우저 파일을 바이트로만 업로드(`att:bytes`). 경로 입력은 금지. 크기·개수·형식 제한, 응답에서 `path` 제거. 결정 필요 D4 |
| 21 | 첨부 제거 | **A** | 그 채팅의, 아직 메시지에 연결되지 않은 첨부만 |
| 22 | 첨부·이미지 보기 | **B** | 그 채팅에 속한 첨부 id만 제공. 이미지만 inline이고 나머지는 다운로드로. `artifacts:previewImage`(로컬 경로 해석)는 **C** |
| 23 | 파일 링크 열기·탐색기·저장 | **C** | PC에서 프로그램이나 탐색기를 실행함 |
| 24 | 프로젝트 목록 | **A** | 기존과 같음. `folder`는 제외 |
| 25 | 새 프로젝트 | **B** | 임의 경로 금지. 데스크톱에서 지정한 **허용 루트** 바로 아래 새 하위 폴더 이름(단일 세그먼트)으로만 만들거나, 기존 프로젝트 폴더를 선택. 결정 필요 D1 |
| 26 | 프로젝트 설정 | **B** | 허용 필드만: 모델·추론, 강점/주의 문구, `reviewGate`, `maxConsults`·`maxReviews`, `max*Workers`(기존 범위 검증). `approvalMode`·`delegateHighRisk`는 18과 같은 확인 규칙. `accountPolicy`는 C |
| 27 | 프로젝트 이름 변경 | **A** | 폴더 변경은 **C** |
| 28 | 프로젝트 보관 / 해제 | **A** | 되돌릴 수 있음 |
| 29 | 프로젝트 삭제 | **C** (권장) | 소속 채팅 전체 기록 삭제, 실행 중 작업자 재설정. 결정 필요 D2(허용한다면 B: 프로젝트 이름 확인 + 실행 중인 채팅이 없을 때만) |
| 30 | 프로젝트 폴더 열기 | **C** | PC 탐색기 실행 |
| 31 | 사용량·잔고 보기 | **B** | 읽기 전용. `cli:info`의 `path`와 계정 이메일 제거. 새로고침(`usage:get(true)`)은 1분에 1회로 제한 |
| 32 | CLI 계정 관리 | **C** | PC에 로그인 콘솔이 뜸, 자격 정보·설정 폴더 |
| 33 | 계정 정책 변경 | **C** (권장) | 어떤 계정·과금으로 실행할지 결정함. 결정 필요 D5(읽기 전용 표시만 B) |
| 34 | Gemini 웹 계정 | **C** | PC에 브라우저 창을 띄우고 Google 로그인 |
| 35 | AI Studio | **C**(설정·실행), **B**(사용 기록 보기: 읽기 전용) | 서비스 실행·계정 연결은 PC에서만 |
| 36 | DeepSeek API 키 | **C** | API 키 |
| 37 | 원격 웹 설정 | **C** | 원격으로 자기 보안 설정을 바꾸지 못하게 함 |
| 38 | 테마 | **A(클라이언트 전용)** | 웹 페이지 자체 다크/라이트 전환, `localStorage`에 저장. **서버 변경 없음**. 데스크톱 테마와 동기화하지 않음(결정 필요 D6) |
| 39 | 창·트레이·업데이트·모니터 | **C** | PC 화면·설치 관련 |

요약

| 분류 | 항목 수 | 항목 |
|---|---|---|
| 기존 | 6 | 1, 7, 9, 10, 14, 15 |
| A 추가 | 15 | 2, 3, 4, 6, 8, 11, 12, 13, 16, 17, 21, 24, 27(이름), 28, 38(클라이언트) |
| B 제한적 추가 | 8 | 5, 18, 20, 22, 25, 26, 31, 35(읽기) |
| C 원격 제외 | 12 | 19, 23, 27(폴더), 29(권장), 30, 32, 33(권장), 34, 35(설정), 36, 37, 39 |

(27과 35는 일부만 허용하므로 두 칸에 모두 들어갑니다.)

---

## 3. API 계약

공통 규칙(기존 `remote-web.ts` 규칙을 그대로 적용합니다)
- 모든 경로는 세션 쿠키가 필요합니다(없으면 401). POST는 `X-CSRF-Token`, 허용된 `Origin`, `Sec-Fetch-Site: same-origin`, `Content-Type: application/json`을 모두 요구합니다. Host가 허용 목록에 없으면 421입니다.
- 오류 본문은 `{ "error": "<한국어 메시지>" }`입니다. 400 형식 오류, 404 없는 대상, 409 상태 충돌(실행 중·이미 처리됨), 413 크기 초과, 415 형식, 429 빈도 제한을 씁니다. 코어에서 난 오류는 400과 그 메시지로 보냅니다.
- 문자열 상한: 제목·이름 200자, 지시·명령 인자 50,000자, 검색어 200자.
- 응답에서 로컬 경로를 제거합니다: `AttachmentRef` → `{id,name,mime,size}`, `Project` → `{id,name,archived,createdAt,settings(허용 필드)}`.
- SSE: 채팅 변경은 기존 `chat:updated`(전체 스트림)로 이미 전달됩니다. 프로젝트 변경은 코어 이벤트가 없으므로, 서버가 변경 API 성공 뒤 `projects:updated`(인자 `[]`)를 직접 발행하고 클라이언트는 `/api/chats`를 다시 읽습니다.

### 3.1 채팅
| 메서드·경로 | 요청 | 응답 | 코어 | 비고 |
|---|---|---|---|---|
| `POST /api/chats` | `{ "projectId": number }` | `201 { chat }` | `chats:create` | 보관된 프로젝트면 409. SSE `chat:updated` |
| `POST /api/chats/:id/update` | `{ title?, archived?, orchestratorModelOverride?, claudeModelOverride?, codexModelOverride?, geminiModelOverride?, grokModelOverride?, deepseekModelOverride?, *EffortOverride?, approvalModeOverride?, confirm? }` | `200 { chat }` | `chats:update` | 모르는 키는 400. 모델 id는 `models:list` 결과로 검증(null = 프로젝트 기본). `approvalModeOverride`가 더 자율적인 쪽(`orchestrator-all`, 또는 `user`→`orchestrator`)이면 `confirm: true`가 필요(없으면 428) |
| `POST /api/chats/:id/delete` | `{ "confirm": "<채팅 제목>" }` | `200 { ok: true }` | `chats:delete` | 제목이 다르면 400. 상태가 working·approval·pausing·paused면 409. 삭제 후 SSE 클라이언트는 목록에서 제거(서버가 `chat:deleted` `[id]` 발행) |
| `POST /api/chats/:id/viewed` | `{}` | `200 { ok }` | `chats:viewed` | |
| `GET /api/search?q=` | — | `200 { chatIds: number[] }` | `chats:search` | 빈 q면 `[]` |
| `POST /api/chats/:id/pause` | `{}` | `200 { ok }` | `chats:pause` | |
| `POST /api/chats/:id/resume` | `{}` | `200 { ok }` | `chats:resume` | 일시정지 재개와 중단된 실행 이어서 진행 모두 |
| `POST /api/chats/:id/dismiss-interrupted` | `{}` | `200 { ok }` | `chats:dismissInterrupted` | |
| `POST /api/chats/:id/command` | `{ "name": "plan"|"plan-run"|"plan-cancel"|"goal"|"review"|"compact", "arg": string }` | `200 { ok }` | `chats:command` | 허용 목록 밖은 400 |
| `GET /api/models?agent=claude|codex|gemini|grok|deepseek` | — | `200 { models: ModelOption[] }` | `models:list` | 결과를 서버에 60초 캐시(모델 id 검증에도 사용) |

### 3.2 첨부 (B)
| 메서드·경로 | 요청 | 응답 | 코어 | 비고 |
|---|---|---|---|---|
| `POST /api/chats/:id/attachments` | `{ "name": string, "mime": string, "data": "<base64>" }` | `201 { attachment: {id,name,mime,size} }` | `att:bytes` | 이 경로만 본문 상한을 늘림(예: 원본 10MB → base64 약 14MB). 형식 허용 목록(이미지·텍스트·PDF·오피스·zip, 결정 D4). 파일명은 경로 구분자 제거·200자. 채팅당 대기 첨부 10개 |
| `POST /api/attachments/:id/remove` | `{}` | `200 { ok }` | `att:remove` | 서버는 원격 세션이 올린 미연결 첨부 id만 기억해서 허용. 그 밖은 404 |
| `POST /api/chats/:id/send` (확장) | `{ text, delivery?, attachmentIds?: number[] }` | 기존 | `chats:send` | `attachmentIds`는 이 채팅에 원격으로 올린 미연결 id만 허용 |
| `GET /api/attachments/:id` | — | 파일 바이트 | `attachment:info` + 파일 읽기 | 첨부가 속한 채팅의 이벤트에 그 id가 있을 때만 제공. `image/png|jpeg|webp|gif`만 inline이고 나머지는 `Content-Disposition: attachment`. `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`. 50MB 초과는 413 |

### 3.3 프로젝트 (A/B)
| 메서드·경로 | 요청 | 응답 | 코어 | 비고 |
|---|---|---|---|---|
| `GET /api/projects` | — | `200 { projects: Project(경로 제외, 허용 settings) [], roots: {id,label}[] }` | `projects:list` | `roots`는 새 프로젝트용 허용 루트(경로 대신 id·표시 이름) |
| `POST /api/projects` | `{ "name": string, "rootId": string, "folderName": string }` | `201 { project }` | `projects:create` | `folderName`은 `^[^\\/:*?"<>|.][^\\/:*?"<>|]{0,63}$`이고 `..` 불가. 서버가 `루트\folderName`을 만들고(이미 있으면 409), 해석한 실제 경로가 루트 아래인지 다시 확인(심볼릭 링크·정션 거부). settings는 `DEFAULT_SETTINGS`. 결정 D1 |
| `POST /api/projects/:id/update` | `{ name?, archived?, settings?: Partial<허용 필드>, confirm? }` | `200 { project }` | `projects:update` | `folder`·`accountPolicy` 키는 400. `approvalMode` 자율성 상승은 `confirm: true`(428). 기존 설정에 병합한 뒤 저장 |

### 3.4 사용량 (B, 읽기 전용)
| 메서드·경로 | 응답 | 코어 | 비고 |
|---|---|---|---|
| `GET /api/usage?refresh=0|1` | `200 { usage: UsageInfo, accounts: {accountId,kind,label,enabled,remainingPercent,authStatus}[] }` | `usage:get`, `cli-accounts:list` | 이메일·`configDir`·`path` 제거. `refresh=1`은 세션당 60초에 1회(초과 시 429) |
| `GET /api/aistudio/usage?range=` | `200 { report }` | `aistudio:usage` | 읽기 전용 |

### 3.5 클라이언트 전용
- **다크 모드**: 서버 변경 없음. 웹에서 `document.documentElement.classList.toggle("dark")`로 바꾸고 `localStorage["cbx-theme"]`에 저장합니다. 기본값은 시스템 설정입니다.
- 보관 항목 보기 토글, 모델 표시 이름 등도 클라이언트 전용입니다.

### 3.6 감사 기록
원격에서 상태를 바꾼 요청(삭제·승인 방식·프로젝트 생성·설정 변경)은 앱의 원격 웹 접속 창에 "최근 원격 변경"(메모리 50건: 시각·세션 사용자·IP·동작)으로 보여 줍니다.

---

## 4. 작업 분할

| 담당 | 범위(scope) | 내용 |
|---|---|---|
| **클로드 1호(서버)** | `src/main/remote-web.ts`, `src/main/remote-web.test.ts`, `src/shared/remote-web.ts`, `src/main/index.ts` | 3장 API 전체, 응답 경로 제거, 검증·확인 규칙, `projects:updated`·`chat:deleted` SSE, 허용 루트 설정(데스크톱 `remote-web.json`의 `projectRoots`), 감사 기록, 테스트 |
| **클로드 2호(웹 UI)** | `src/renderer/src/remote/**`, `src/renderer/remote.html` | 화면: 새 채팅/프로젝트, 이름 변경·보관·삭제(확인 입력), 모델·추론·승인 방식 선택, 명령 메뉴, 일시정지/재개/이어서 진행, 첨부 업로드·보기, 검색, 사용량, 다크 모드 토글. `api.ts` 확장 |
| 데스크톱 설정 UI(허용 루트 입력·감사 기록 표시) | `src/renderer/src/components/RemoteWebDialog.tsx` | 서버 담당(1호)이 함께 맡음(설정 IPC와 한 묶음) |

순서와 공유 타입
1. **공유 타입 파일 `src/shared/remote-web.ts`는 1호 소유**입니다. 1호가 먼저 API 요청·응답 타입(`RemoteProject`, `RemoteAttachment`, `RemoteChatPatch`, `RemoteProjectCreate`, `RemoteUsage` 등)과 엔드포인트 경로 상수를 커밋하고 2호에게 알립니다. 2호는 이 파일을 **읽기만** 합니다(변경이 필요하면 1호에게 요청).
2. 2호는 타입이 확정된 뒤 UI를 구현합니다. 서버가 완성되기 전에는 `api.ts`를 기준으로 화면을 만들고, 통합 시험은 1호 서버 완료 후 `scripts/e2e-remote-web.mjs`를 확장해 진행합니다(e2e 스크립트는 1호 소유. 현재 미커밋 변경은 작성자 확인 후 처리).
3. `src/shared/types.ts`, `src/main/core.ts`, `src/main/orchestrator.ts`는 이번 확장에서 바꾸지 않습니다. 필요하면 마스터 승인 후 1호가 맡습니다.
4. 두 담당의 파일 범위는 겹치지 않습니다. `timeline.ts` 같은 데스크톱 공용 모듈은 둘 다 수정하지 않습니다.

---

## 5. 업데이트 적용 방법 (확인 결과)

- 현재 설치본: `C:\Users\damki\AppData\Local\Programs\ai-chatterbox\`(NSIS 사용자별 설치). 2026-10-29 22:15에 `dist\AI_ChatterBox-0.4.36-setup.exe`(feature/remote-web 빌드)로 설치됐고 원격 웹이 동작 중입니다.
- 서버 코드(화면 프로세스 `out/main`)와 웹 페이지(`out/renderer/remote.html`, assets)는 모두 `app.asar` 안에 있습니다. 그래서 **어느 쪽을 바꿔도 새 설치 파일 빌드 → 설치 → 앱 재시작**이 필요합니다(웹 페이지만 바꿔도 asar 교체가 필요).
- 절차
  1. `npm run typecheck`, `npm test`, `npx electron-vite build`, `node scripts/e2e-remote-web.mjs` 통과를 확인합니다.
  2. `npm run dist` → `dist\AI_ChatterBox-<버전>-setup.exe`. 같은 0.4.36이면 수동 설치는 되지만 GitHub 자동 업데이트에는 버전이 오르지 않습니다. **버전을 0.4.37로 올리기를 권장**합니다(결정 D7).
  3. 진행 중인 작업이 없을 때 트레이에서 앱을 완전히 종료합니다(관리자 코어 포함). 이 앱 안에서 도는 마스터 세션도 끝나므로 사용자가 직접 시점을 정합니다.
  4. 설치 파일을 실행합니다(oneClick, 같은 경로 덮어쓰기). `%APPDATA%\AI_ChatterBox`의 데이터·`remote-web.json`은 유지됩니다(`deleteAppDataOnUninstall: false`).
  5. 앱 실행 → 원격 웹 접속 상태가 "실행 중"인지 확인 → 휴대폰에서 새 기능을 확인합니다. 원격 세션은 메모리에만 있어 재시작 후 다시 로그인해야 합니다.
- Caddy(이 PC·NAS)는 경로가 같으므로 변경할 필요가 없습니다.

---

## 6. 사용자 결정 (2026-10-29 전부 승인됨)

| ID | 결정 | 확정안 | 상태 |
|---|---|---|---|
| D1 | 원격 새 프로젝트의 폴더 | 데스크톱에서 지정한 **허용 루트**(예: `D:\AI`) 아래 새 하위 폴더만 허용. 허용 루트가 비어 있으면 기능 꺼짐. `copyFolderFrom`(기존 프로젝트 폴더 재사용)은 쓰지 않음 | ✅ 승인됨 |
| D2 | 원격 프로젝트 삭제 | 원격 불가(데스크톱 전용) | ✅ 승인됨 |
| D3 | 원격 승인 방식 변경(채팅·프로젝트) | 허용. 더 자율적인 쪽으로 바꿀 때는 확인(`confirm: true`, 없으면 428) + 감사 기록 | ✅ 승인됨 |
| D4 | 원격 첨부 업로드 | 허용. 파일당 10MB, 채팅당 대기 10개, 형식 허용 목록(이미지·텍스트·PDF·오피스·zip), 실행 파일 형식 거부 | ✅ 승인됨 |
| D5 | 원격 CLI 계정·계정 정책 변경 | 원격 불가(읽기 전용 사용량만) | ✅ 승인됨 |
| D6 | 다크 모드 범위 | 웹 전용(브라우저별 `localStorage`). 데스크톱 테마와 동기화하지 않음 | ✅ 승인됨 |
| D7 | 배포 버전 | 0.4.37로 올려 빌드. 설치·재시작 시점은 사용자가 결정 | ✅ 승인됨 |
| D8 | 원격 채팅 삭제 | 허용(제목 입력 확인, 실행 중이면 409) | ✅ 승인됨 |

공유 타입과 경로 상수는 `src/shared/remote-web.ts`의 "원격 웹 기능 확장 API" 절에 정의했습니다(구현 전 계약). 3장 표와 이름이 다르면 타입 파일을 기준으로 합니다.
