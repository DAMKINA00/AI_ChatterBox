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
| `GET /api/usage?refresh=0|1` | `200 RemoteUsageResponse { groups: UsageKindGroup[], deepseek? }` (2026-11-12 변경, 아래 절) | `usage:get`, `cli-accounts:list` | 데스크톱 사용량 패널과 같은 보기(`shared/usage-view.ts`). 이메일·`configDir`·경로 없음, 오류는 코드별 고정 문구만, 이메일·경로·토큰처럼 보이는 라벨은 `계정 N`(docs/usage-monitor-protocol.md). `refresh=1`은 세션당 60초에 1회(초과 시 429) |
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

### 보안 리뷰 반영 (2026-10-30, 협의 2642)
- **원자적 변경(#1·#5):** 채팅 설정·프로젝트 설정·채팅 삭제는 코어 채널 `remote:chat-patch`, `remote:project-patch`, `remote:chat-delete`에서 처리합니다. 현재 상태를 읽고, D3 자율성을 비교하고, 저장하는 것을 await 없이 한 번에 합니다(`src/main/remote-core.ts`). 그래서 그 사이 데스크톱에서 바꾼 승인 방식·계정 정책을 덮어쓰지 않습니다.
  - 프로젝트 설정은 보낸 허용 키만 현재 설정에 병합합니다.
  - 삭제는 코어가 제목·유휴 상태를 다시 확인합니다. 실행 중이면 409이고 강제로 중지하지 않습니다. 삭제하는 동안 그 채팅에 대한 send·command·resume을 거부합니다.
- **숫자 범위(#2):** `REMOTE_NUMBER_SETTINGS`(데스크톱 대화상자와 같은 범위)로 검증합니다: 클로드·지피티 작업자 1~6, 제미나이·그록·딥시크 0~6, 배정 한도 1~999, 리뷰 0~99.
- **첨부(#3·#4):**
  - 업로드는 한 번에 하나씩 처리하므로 동시 업로드도 10개를 넘지 못합니다. 미전송 첨부의 총 용량은 채팅당 30MB, 전체 200MB입니다(4차 리뷰부터 DB에서 계산).
  - 미전송 첨부 제거는 4차 리뷰 절의 방식으로 바뀌었습니다(DB 행 삭제 → 정리 실행).
  - 파일명은 Windows 기준으로 정규화합니다(끝 점·공백 제거, `\ / :`(ADS)·제어 문자·예약 장치명 거부). 그 뒤 **확장자 허용 목록**(`REMOTE_ATTACHMENT_TYPES`)만 받고, MIME은 서버가 확장자로 정합니다.
  - 이미지는 png·jpeg·gif·webp만 받으며 형식별 매직 바이트가 필수입니다. SVG·BMP는 거부합니다. 텍스트는 NUL 바이트가 없어야 하고, 스크립트(.py .ps1 .psm1 .bat .cmd .vbs .js .sh 등)는 거부합니다.
  - **한계:** 매직 바이트 검사는 폴리글랏 파일(예: 앞부분은 정상 PNG·PDF·ZIP이고 뒤에 다른 내용을 붙인 파일)을 막지 못합니다. 첨부는 실행하지 않고 AI 작업자가 읽기 자료로만 씁니다. 원격 다운로드는 이미지 외에는 `attachment`·`nosniff`·`sandbox`로 제공합니다.
- **SSE(#6):** `chat:deleted`, `projects:updated`를 모든 원격 웹 스트림에 보냅니다.
- **AI Studio 사용량(#7):** 계정 그룹 키(이메일)를 "계정 1, 2…"로 바꿔 보냅니다.
- **허용 루트(#8):** 등록할 때 실제 경로와 파일 식별자(볼륨·파일 번호)를 기록합니다. 생성할 때 다시 대조해서 다르면(정션·링크 교체) 409이고, 폴더를 만든 뒤에도 한 번 더 확인합니다.
- **비상용 로컬 로그인(운영 결정):** 기본은 LAN·루프백 클라이언트 IP(사설 대역, Caddy가 전달한 실제 IP 기준)에서만 받습니다. 인터넷 IP에서는 통일 실패 응답을 보냅니다. 데스크톱 원격 웹 접속 창의 "인터넷에서도 비상용 로그인 허용"(기본 꺼짐)은 비상용 비밀번호가 20자 이상일 때만 켤 수 있고, 더 짧은 비밀번호로 바꾸면 자동으로 꺼집니다.

### 보안 재리뷰 반영 (2026-10-30, 협의 2650)
- **접속자 판정 실패 시 닫힘(#1):** 접속 종류를 `local`·`lan`·`internet`·`unknown` 넷으로 나눕니다(`RemoteWeb.client`).
  - `local`은 프록시 헤더 없이 Host가 `127.0.0.1/localhost:포트`인 이 PC 직접 접속뿐입니다.
  - Caddy 헤더는 신뢰 프록시 설정이 켜져 있을 때만 씁니다.
  - 헤더가 없는 공개 Host 요청, 잘못된 헤더, 신뢰 꺼짐 상태의 헤더는 모두 `unknown`입니다. `unknown`은 하나의 잠금 묶음("unknown")으로 세고, 비상용 로그인은 항상 거부합니다(통일 실패 응답).
- **첨부 파일 정리(#2·#3):** (4차 리뷰에서 대체됨, 아래 절 참고) 지울 때 링크·정션 여부(lstat)와 실제 경로(realpath)를 대조하는 원칙은 4차 정리에도 남아 있습니다.
  - 채팅 폴더 전체 삭제는 하지 않습니다.
  - 업로드 중 채팅이 삭제돼 DB 기록이 실패하면(FK) 써 둔 파일을 지웁니다.

### 보안 3차 리뷰 반영 (2026-10-30, 협의 2659)
- **첨부 파일 보존(#2, 마스터 결정):** 원격 채팅 삭제도 데스크톱과 같게 기존·전송 완료 첨부 파일을 보존합니다. 정리 대상은 원격으로 올렸고 아직 보내지 않은(DB상 미연결) 파일뿐이었습니다. 5차에서 원격 업로드에 한해 채팅을 삭제하면 보낸 것까지 지우도록 바뀌었습니다(데스크톱 첨부는 계속 보존).
- **재시도 안전(#1)·실패 추적(#3):** 메모리의 업로드 기록(`RemoteUploads`)과 id·경로·파일 식별자 기반 재시도 목록을 썼으나, 4차 리뷰에서 전부 없애고 아래 절의 단일 정리로 바꿨습니다. 코어의 `HTTP409`를 웹에서 409로 응답하는 것은 그대로입니다.
- **Caddy 예시(#4):** `docs/remote-web.Caddyfile` 전역 옵션에 운영과 같이 `trusted_proxies_strict`를 넣었습니다.
- **예전 허용 루트(#4):** 실제 경로·파일 식별자가 없는 루트는 원격 생성을 409로 거부합니다. 데스크톱 창에 "재등록 필요"로 표시되며, 목록을 다시 저장하면 그 시점 기준으로 고정됩니다.
- **세션 회수(#5):** 세션에 로그인 방식과 접속 종류를 기록합니다. 인터넷 비상 로그인 허용을 끄거나, 비밀번호를 20자 미만으로 바꿔 자동으로 꺼지면 인터넷·불명 접속의 로컬 비밀번호 세션을 끝내고, 진행 중인 로그인을 무효화합니다(세대 증가).
- **운영 Caddy:** PC Caddyfile 전역 `servers`에 `trusted_proxies_strict`를 추가했습니다(백업 `Caddyfile.bak-20261030-0044-strict`).
  - NAS Caddy는 XFF를 실제 접속자 하나로 교체하므로 결과는 같습니다. 앞단(신뢰 프록시 없음)과 뒷단(신뢰+strict)을 임시 Caddy로 재현해, 위조한 `X-Forwarded-For: 192.168.0.5`가 쓰이지 않음을 확인했습니다.
  - 운영 경로에서 앱이 받은 IP 값은 Caddy 접근 로그가 없고 설치된 앱이 이전 빌드라 확인하지 못했습니다. 앱 쪽 판정은 단위 테스트로 대신했습니다.

### 보안 4차 리뷰 반영 (2026-10-30, 협의 2663, 마스터 결정: 단순·멱등한 정리)
원격 업로드를 추적하던 메모리 상태(대기 목록·재시도 큐·파일 식별자)를 모두 없앴습니다. 판단은 매번 DB와 폴더에서 다시 계산합니다. 웹 입력창의 첨부 목록은 `GET /api/chats/:id/attachments`가 기준입니다. 정리된 첨부로 보내면 409이고, 웹은 목록을 새로 받습니다.
- 이 절의 나머지 내용은 5차 리뷰에서 바뀌었습니다(아래 절 참고).
  - 전송 시 채팅 폴더로 파일 이동·되돌리기
  - 24시간 자동 만료
  - 파일 이름 기준 행 매칭과 행 삭제

### 보안 5차 리뷰 반영 (2026-10-30, 협의 2676, 마스터 결정 A~F)
- **보관(A):**
  - 원격 업로드 파일은 보냈든 안 보냈든 `첨부 루트\remote-pending\<임의 UUID><확장자>`에 그대로 둡니다.
  - 전송은 DB 행을 메시지에 연결할 뿐이며, 파일 이동이 없습니다. 그래서 전송 도중 종료돼도 파일과 행이 어긋나지 않습니다.
  - 데스크톱 첨부(`첨부 루트\<채팅 id>\`)는 기존 그대로입니다.
- **수명(B):** 원격 업로드 파일은 그 파일을 참조하는 DB 행이 있는 동안만 남습니다.
  - 첨부를 제거하거나 채팅·프로젝트를 삭제해 행이 사라지면, 보낸 것까지 파일을 지웁니다.
  - 데스크톱에서 붙인 첨부 파일은 채팅을 삭제해도 남습니다.
  - 웹의 채팅 삭제 확인 문구와 데스크톱의 채팅·프로젝트 삭제 확인 문구에 이 내용을 적었습니다.
- **정리(C, `AttachmentStore.gcRemoteUploads`):** 동기 함수라 전송·업로드와 섞이지 않고, 예외를 던지지 않으며, DB 행은 지우지 않습니다.
  - 실행 시점: 앱 시작, 10분마다, 첨부 제거 뒤, 원격·데스크톱 채팅 삭제와 프로젝트 삭제 뒤.
  - 대상: `remote-pending` 바로 아래에서 앱이 붙이는 이름(소문자 UUID + 허용 확장자)인 파일만 봅니다. 다른 이름은 손대지 않습니다.
  - 삭제 조건: 모든 첨부 행(모든 채팅, 전송 여부 무관)의 **정규화한 전체 경로**(Windows는 대소문자 무시) 중 이 파일을 가리키는 것이 하나도 없을 때만 지웁니다. 다른 폴더에 같은 이름의 파일이나 행이 있어도 서로 영향이 없습니다.
  - 유예: 만든 지 10분이 안 된 파일은 남깁니다(기록 중인 업로드 보호). 예외는 제거·삭제를 실행한 코어가 방금 행을 지운 파일로, 바로 지웁니다.
  - 건너뛰는 항목: 링크·정션·폴더, 실제 경로가 실제 폴더 바로 아래가 아닌 파일, 확인할 수 없는 파일, 폴더 자체가 링크인 경우의 전체. 삭제에 실패한 파일은 다음 실행에서 다시 봅니다.
  - 24시간 자동 만료는 없앴습니다. 보내지 않은 첨부는 사용자가 제거하거나 채팅을 삭제할 때까지 남습니다.
- **식별(D):**
  - DB 첨부 행에 바뀌지 않는 `uuid` 열을 추가했습니다(마이그레이션, 파일 이름과 같음, 데스크톱 첨부는 NULL).
  - 원격 API는 업로드를 `{id, uuid}` 쌍으로 지정합니다.
    - 전송: `attachments: [{id, uuid}]`. 예전 `attachmentIds`는 400입니다.
    - 제거: 본문 `{uuid}`
    - 목록과 업로드 응답에도 `uuid`가 들어 있습니다.
    - 보내지 않은 업로드를 내려받을 때는 `&uuid=`가 필요합니다.
  - 코어가 같은 동기 단계에서 쌍을 확인합니다. 지워진 업로드의 id를 SQLite가 새 업로드에 다시 줘도 uuid가 다르므로, 이전 목록을 가진 세션의 전송·제거는 409로 거부됩니다.
  - 파일이 밖에서 사라진 업로드는 목록에서 빠지고, 보내면 409입니다.
- **업로드 수신 제한(E):** 본문을 읽기 전에 `Content-Length`로 자리를 예약합니다. 길이가 없으면 최대 크기로 예약하고, 본문은 예약한 길이까지만 읽습니다.
  - 동시 업로드는 전체 4개, 세션당 2개까지입니다.
  - 받는 중인 본문의 합계는 40MB까지입니다. 마스터 예시는 60MB였지만, 그 값이면 최대 본문(약 14MB) 4개도 들어가 바이트 상한이 작동하지 않아 낮췄습니다. 그래서 큰 업로드는 동시에 2개까지입니다.
  - 넘으면 429(`Retry-After`)이고, 본문 하나가 상한을 넘으면 413입니다.
  - 예약은 성공·오류·연결 끊김 어느 경우든 한 번만 해제합니다.
  - 저장된 미전송 기준 한도(채팅당 10개·30MB, 전체 200MB)와 한 번에 하나씩 처리하는 업로드 순서는 그대로입니다.
- **정리한 코드(F):**
  - 전송 시 이동·되돌리기(`keepSentUpload`·`returnUnsentUpload`·`setAttachmentPath`·`sendRemoteUploads`)
  - 24시간 만료
  - 파일 이름 기준 행 매칭(`attachmentFileRefs`)
  - 정리 중 행 삭제
- **지적별 해결:**
  1. 전송의 비원자성: 파일을 옮기지 않으므로 이동 중 종료라는 경우가 없습니다. 메시지 기록 후 연결 전에 종료되면 행은 미전송으로 남고 파일도 그대로라 다시 보낼 수 있습니다.
  2. 같은 이름 다른 폴더의 행 삭제: 정리는 행을 지우지 않습니다. 참조는 정규화한 전체 경로로만 판단합니다.
  3. 본문 수신 전 상한 없음: 위 E의 예약으로 막았습니다.
  4. 오래된 id로 새 업로드를 전송·삭제: `{id, uuid}` 확인으로 409가 됩니다.
  5. UUID가 아닌 파일 삭제: 앱이 붙이는 이름만 대상으로 합니다.
  6. 승인되지 않은 24시간 만료: 없앴습니다.
- **남은 한계:**
  - 메시지 기록과 첨부 연결은 기존 `chats.send` 그대로 두 문장이며, 트랜잭션이 아닙니다. 그 사이에 종료되면 기록에는 첨부가 보이지만 행은 미전송으로 남아 다시 보낼 수 있습니다(파일은 보존).
  - 링크 확인과 삭제 사이의 경쟁(TOCTOU)은 이 PC에서 폴더를 직접 바꾸는 경우에만 해당합니다.
- **테스트:**
  - 실제 SQLite·`ChatManager`·파일로 확인합니다(`src/main/attachments-remote.test.ts`).
    - id 재사용과 uuid 불일치 409(제거·전송)
    - 전송 각 단계 실패·종료 후 재시작 시 파일·행 일관성
    - 기록 전 종료로 남은 파일의 유예 후 정리
    - UUID가 아닌 파일·링크·정션·폴더 보존
    - 같은 이름 다른 폴더 행 보존
    - 경로 표기가 다른 참조의 보존
    - 채팅 삭제 시 원격 업로드(보낸 것 포함) 정리와 데스크톱 첨부 보존
    - 잠긴 파일의 다음 실행 정리
    - 사라진 파일 목록 제외·409
    - FK 실패 시 파일 없음
    - uuid 열 마이그레이션
  - HTTP(`remote-features.test.ts`): 동시 업로드 상한(전체·세션·바이트), 연결 끊김 시 예약 해제, 다른 세션의 id 재사용 409, `{id, uuid}` 형식 검사, uuid 없는 미전송 다운로드 404.

### 보안 6차 리뷰 반영 (2026-10-30, 협의 2688)
- **원격 첨부 총 저장량 상한(차단 요인):** 미전송 한도만으로는 업로드→전송을 반복해 디스크를 채울 수 있었습니다.
  - 이제 코어가 저장 직전, 파일을 쓰기까지의 동기 구간(`saveRemoteUpload`)에서 두 가지를 확인합니다. 하나라도 어기면 507입니다.
    - 모든 원격 업로드(`uuid`가 있는 행, 전송 여부 무관)의 크기 합 + 이번 파일 ≤ 한도
    - 저장 후에도 디스크 여유 공간(`statfs`)이 5GB 이상
  - 한도는 기본 2GB이고, 데스크톱 원격 웹 접속 창의 "원격 첨부 저장 한도"에서 0.1~20GB로 바꿀 수 있습니다(`uploadStorageGb`).
  - 코어는 받은 값을 이 범위로 다시 제한합니다. 여유 공간을 확인할 수 없을 때도 저장하지 않습니다(507).
  - 공간은 원격 첨부가 있는 채팅·프로젝트를 삭제하면 돌아옵니다.
  - 미전송 기준 한도(채팅당 10개·30MB, 전체 200MB)와 수신 중 예약(429/413)은 그대로입니다.
  - 웹은 서버의 507 문구를 그대로 보여 줍니다.
- **메시지 기록과 첨부 연결을 한 트랜잭션으로(개선):**
  - `Store.addUserEvent`가 메시지 기록과 첨부 연결을 SAVEPOINT 하나로 묶습니다. 바깥 트랜잭션 안에서도 쓸 수 있습니다.
  - `chats.send`의 작업 중 추가 지시 경로와 `startTurn` 경로 모두 이것을 씁니다. 그래서 그 사이에 실패하거나 종료돼도 기록만 남는 일이 없습니다.
  - 데스크톱 전송 경로는 같은 함수를 거치며 동작은 같습니다.
- **테스트:**
  - `attachments-remote.test.ts`
    - 최소 한도 0.1GB에서 10MB 업로드→전송을 반복하면 11번째가 507이고 파일을 쓰지 않음
    - 채팅을 삭제하면 공간이 돌아옴
    - 여유 공간이 5GB 미만이거나 확인할 수 없으면 507
    - 실제 `statfs` 값 확인
    - 연결 실패 시 메시지 기록도 롤백
    - 바깥 트랜잭션 안에서의 SAVEPOINT 동작
    - 데스크톱 전송 회귀
  - `remote-features.test.ts`: 설정 범위 검사, HTTP 507 문구, 한도 변경의 즉시 반영
  - e2e: 설정 창의 기본값 표시와 저장

### 사용량 표시를 ChatterBox 계정 저장소로 통일 (2026-11-12)
- 데스크톱 사용량 패널, 명령 팔레트의 "남은 사용량", 원격 웹 사용량 창이 모두 `src/shared/usage-view.ts`의 `usageGroups(cli-accounts:list, usage:get)`를 씁니다.
  - 계정 목록·순서·라벨·배정 제외 여부는 ChatterBox CLI 계정 저장소 하나에서 옵니다.
  - 각 계정의 값은 그 계정에 저장된 조회 결과입니다(잔여, 창, 리셋 시각, `checkedAt`).
  - 계정 저장소에 값이 없을 때만 실시간 값을 쓰고, 기본 `*-1` 계정에 한해 예전 계열 값을 씁니다.
- ChatterBox에서 계정을 추가·이름 변경·배정 제외·삭제하면 다음 조회부터 그대로 보입니다.
  - 데스크톱은 사용량이 갱신될 때마다 계정 목록을 다시 읽습니다.
  - 삭제된 계정에 남은 값이나 폐기된 Gemini CLI 값은 표시하지 않습니다.
- `GET /api/usage` 응답이 `{ usage: UsageInfo, accounts }`에서 `{ groups, deepseek? }`로 바뀌었습니다.
  - 원본 사용량 데이터를 보내지 않습니다(Gemini 웹 상세 문구 포함).
  - 계정 행에는 이메일·폴더가 없습니다. 오류는 원문 대신 코드별 고정 문구만 보내고, 이메일·경로·토큰처럼 보이는 라벨은 `계정 N`으로 바꿉니다(규칙: `docs/usage-monitor-protocol.md`).
- 함께 빌드되는 AIUsageMonitor는 자체 설정(`%LOCALAPPDATA%\AIUsageMonitor\settings.json`의 추가 계정·알림 임계값)과 자체 조회를 그대로 씁니다. 바꾸려면 그 저장소를 수정해야 하므로 선택지만 보고했습니다.

### 구현 중 계약 변경 (2026-10-30, 클로드 2호에게 통지함)
- `GET /api/attachments/:id`에 `?chat=<chatId>` 필수. 없으면 400, 첨부가 그 채팅의 기록이나 원격 미전송 업로드에 없으면 404.
- (4차) `GET /api/chats/:id/attachments` → `RemoteAttachmentList`(그 채팅의 미전송 원격 업로드). 보내려는 첨부가 이미 없거나 이 채팅의 미전송 원격 업로드가 아니면 409(이전 400).
- (5차) 원격 업로드는 `{id, uuid}`로 지정합니다: 전송 `attachments: RemoteUploadKey[]`(예전 `attachmentIds`는 400), 제거 본문 `RemoteAttachmentRemove {uuid}`, 목록·업로드 응답은 `RemoteUpload`(uuid 포함), 미전송 업로드 다운로드는 `&uuid=` 필요. 업로드는 수신 전 예약으로 429/413.
- `POST /api/chats/:id/send`: 첨부가 1개 이상이면 `text`가 빈 문자열이어도 허용(데스크톱 입력창과 같음).
- 서버 구현은 `src/main/remote-features.ts`(새 경로)이고, `remote-web.ts`가 세션·CSRF·Origin·Host 검사 뒤 위임합니다. 기존 `/send`도 이 모듈로 옮겼습니다.
- 알려진 한계: 원격 채팅 생성·수정은 `chat:updated`로 데스크톱 창에 바로 반영되지만, 원격 채팅 삭제·프로젝트 생성/수정은 데스크톱 창 목록에 반영할 이벤트가 없습니다(데스크톱 `store.ts` 변경이 필요). 앱을 다시 열면 반영됩니다.

공유 타입과 경로 상수는 `src/shared/remote-web.ts`의 "원격 웹 기능 확장 API" 절에 정의했습니다(구현 전 계약). 3장 표와 이름이 다르면 타입 파일을 기준으로 합니다.
