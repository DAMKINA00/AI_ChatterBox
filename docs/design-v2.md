# AI_ChatterBox v2 설계: 하나의 채팅, 마스터와 작업자 팀

## 0. 무엇이 바뀌나
- v1: Claude·Codex 세션을 따로 열어 각각 대화 → v2: 채팅 하나에 지시하면 Claude(리드)와 Codex(GPT-6 Astra, 모델 id `gpt-6-astra`)가 알아서 협의하며 작업
- 구조: 프로젝트(폴더 지정) → 채팅 → 협의 스레드 트리
- 입력: 텍스트 + 이미지 첨부, 클립보드 붙여넣기(Ctrl+V), 드래그 앤 드롭
- 화면: 마크다운·코드 하이라이트, 도구 호출 카드, diff, 진행 상태, 인라인 승인

## 1. 참고 (패턴만 차용, 포크 안 함)
Orkas Commander 패턴(리드가 하위 작업 위임), Poracode Crossagents(Claude가 Codex 호출, 하위 출력이 부모 스레드로 스트리밍), OpenAI codex-plugin-cc(/codex:review, /codex:rescue; 리뷰 게이트 루프 위험→회수 제한), Codex↔Claude MCP(도구 타임아웃 기본 60초가 긴 작업을 끊음→길게), clideck(사이드바 상태·읽지 않음 표시, 이미지·diff 미리보기), parallel-code(worktree, diff·병합).

## 2. 협업 방식: 리드 + 협의(consult)
사용자 지시(텍스트·이미지) → 리드(Claude): 계획 → consult_codex(구현 위임 / 리뷰 / 의견) → 앱(Bridge)이 Codex 스레드에 턴 전달 → Codex 작업(파일 수정 가능) → 결과 요약 반환 → 리드가 확인·수정 → 필요시 재협의 → 마지막에 Codex 리뷰 → 사용자에게 최종 보고.
- 리드는 프로젝트 설정에서 선택(기본 Claude). Codex가 리드면 consult_claude 사용(대칭 구현).
- Bridge MCP 서버(main 프로세스, 127.0.0.1 HTTP + 토큰) 도구:
  - consult_codex(message, kind: implement|review|opinion, attach?) → Codex 최종 답변 + 변경 파일 목록
  - ask_user(question, options?) → 채팅에 선택 카드, 답이 도구 결과로 반환
- 채팅마다 Codex 스레드 하나를 계속 사용(맥락 유지). 협의 = 그 스레드의 턴, 트리에는 협의 단위로 표시.
- 역할 지시: 리드에 --append-system-prompt("Codex와 팀, 중요한 코드 변경은 끝내기 전에 Codex 리뷰" 등), Codex에 개발자 지시("Claude가 맡긴 일을 하고 결과를 요약").
- 리드는 협의 결과를 기다리는 동안 멈춰 있으므로 한 번에 한 에이전트만 파일 수정.
- 긴 작업: Claude MCP_TOOL_TIMEOUT, Codex tool_timeout_sec 길게(30분). 협의 중 Codex 출력은 채팅에 실시간 표시.
- 한도: 지시 1건당 협의 8회, 리뷰 왕복 3회, 같은 요청 반복 2회 거절, 지시 1건당 60분 → 걸리면 리드에게 "한도 도달, 지금까지 결과를 보고" 반환 또는 일시정지+사용자 확인.
- 사용자: 언제든 중지(두 에이전트 모두) 또는 추가 지시(다음 턴 경계에 리드에게 전달).
- 승인: 두 에이전트 요청이 같은 채팅에 인라인 카드: 이번만 허용 / 이 채팅 동안 허용 / 거부. 읽기 전용은 자동 허용, 작업 폴더 밖 쓰기·삭제·git push·자격 증명 접근은 항상 묻기. 상대 에이전트의 요청이 권한을 올리지 못함. --dangerously-skip-permissions / Codex yolo 금지.

## 2-1. 세 역할과 모델 설정 (2절의 "리드 = Claude + consult_codex"를 대체)
- 역할 셋, 채팅마다 세션/스레드 셋: **오케스트레이터**, **Claude 작업자**, **GPT 작업자**. 오케스트레이터 세션을 작업자로 재사용하지 않음.
- 모델 설정 셋은 **프로젝트별**(프로젝트 설정 창). 기본값(오케스트레이터 Claude Opus, Claude `opus`, GPT `gpt-6-astra`)은 새 프로젝트 양식을 미리 채울 뿐 별도 앱 설정 단계는 없음.
  1. 오케스트레이터 모델: 드롭다운 하나에 Claude 모델과 GPT 모델을 함께 표시. Claude 모델을 고르면 Claude CLI로, GPT 모델을 고르면 Codex CLI로 실행.
  2. Claude 모델(작업자): Claude CLI가 알려 주는 목록(stream-json `control_request` `initialize` 응답의 `models`) + 직접 입력.
  3. GPT 모델(작업자): Codex app-server `model/list` + 직접 입력.
- 채팅은 프로젝트 값을 상속. 채팅 상단 바에서 **오케스트레이터·Claude·GPT 모델 셋 모두** 채팅별로 바꿀 수 있고(v0.2.1), "프로젝트 기본값" 표시와 "프로젝트 값 사용"으로 되돌리기를 제공. 바꾸지 않은 값은 이후 프로젝트 변경을 따라가고, 바꾼 값은 유지. 변경은 다음 지시부터 적용.
- 오케스트레이터가 다른 CLI(Claude ↔ GPT)로 바뀌면 그 CLI의 오케스트레이터 세션을 쓰고, 첫 지시 앞에 지금까지의 대화 요약(사용자 지시, 오케스트레이터 답, 협의 결과)을 붙여 넘긴다.
- 오케스트레이터 도구(Bridge MCP): `consult_claude(message, kind, attach?)`, `consult_codex(message, kind, attach?)`, `ask_user(question, options?)`; kind = implement | review | opinion.
- 오케스트레이터는 **읽기 전용**: Claude는 쓰기·명령 도구 차단(`--disallowedTools`), Codex는 read-only 샌드박스 + 승인 요청 없음. 파일 수정은 작업자만, 한 번에 한 작업자.
- 기본 흐름: 오케스트레이터 계획 → 작업자 하나에 구현 위임 → 다른 작업자에게 리뷰 요청 → 수정 → 최종 보고. 누가 무엇을 할지는 오케스트레이터가 결정.
- 트리: 채팅 아래 `오케스트레이터 대화 · Claude 대화 · GPT 대화 · 협의 N`. 타임라인의 협의 카드에 "오케스트레이터 → GPT · 구현 위임"처럼 누가 누구에게 맡겼는지 표시.
- 한도(지시당 협의 8회, 리뷰 왕복 3회 등)는 두 작업자를 합쳐서 셈.

## 2-2. 마스터와 작업자 풀 (v0.3.0)
- 이름: 마스터 → **마스터**(화면, 트리, 카드, 설정, 프롬프트, 명령 문구 전부). 작업자는 **클로드 N호 / 지피티 N호**. 한 채팅 안에서 번호는 다시 쓰지 않는다.
- 작업자 수는 고정이 아니다. 마스터가 일의 양에 맞춰 만들고 해제한다. Bridge MCP 도구:
  - 마스터: `spawn(kind: claude|gpt, job)` → 닉네임, `ask(to: 닉네임, message, kind: implement|review|opinion, scope?: 경로 glob)`, `release(닉네임)`, `agents()`, `checklist(steps)`, `update_goal`, `ask_user`.
  - 작업자: `ask(to: 닉네임, message, kind)`로 서로 부르고, `agents()`로 팀을 본다. 작업자를 만드는 건 마스터뿐이고, 없는 닉네임은 오류. 마스터에게 ask는 교착 방지로 거절(결과 보고에 질문을 적게 함).
  - 작업자마다 자기 Claude 세션 / Codex 스레드를 가진다(클로드는 프로젝트·채팅의 Claude 모델, 지피티는 GPT 모델).
- 병렬: 작업자 한 명은 한 번에 한 턴. review/opinion은 동시에 진행. implement는 scope를 가지며, 겹치지 않는 scope끼리는 동시에, 겹치면 차례로. scope 밖 쓰기(그리고 review/opinion 중의 모든 쓰기)는 승인 단계에서 이유와 함께 자동 거부. Codex 작업자는 scope가 있는 구현과 리뷰·의견 턴을 읽기 전용으로 돌려서 모든 쓰기가 이 검사를 거치게 한다. worktree 분리는 이후 옵션.
- 교착 방지: B가 A를 기다리는 중에 A가 B를 부르는 것처럼 순환이 생기는 호출은 분명한 메시지로 거절. 호출 깊이 최대 3.
- 한도: 채팅당 동시에 클로드 3명 + 지피티 3명(프로젝트 설정). 지시당 맡기기 횟수는 작업자 수에 따라 늘어남(최대 24). 상단 작업자 칩에 "작업자가 많을수록 사용량이 빨리 줄어요" 안내. 중지·추가 지시·자동 승인·트레이·이어서 진행 모두 N명에서 동작(이어서 진행 시 각 작업자의 세션 id 유지).
- 트리: 채팅 → 마스터 대화 · 클로드 1호 · 클로드 2호 · 지피티 1호 …(해제된 작업자는 흐리게) · 협의 N (보낸 쪽 → 받는 쪽). 상단에 작업자 칩(닉네임 + 작업 중/대기). 카드: "마스터 → 클로드 2호 · 구현 · src/ui/**".
- 이전 데이터: 기존 채팅의 마스터 → 마스터, Claude 작업자 → 클로드 1호, GPT 작업자 → 지피티 1호 (세션/스레드 id, 이벤트, 협의 그대로).

## 2-3. 승인: 마스터 자동 판단 (v0.2.1)
- 승인 방식은 프로젝트 설정(기본 **마스터 자동 판단**, 또는 매번 직접 승인), 채팅 상단에서 채팅별로 바꿀 수 있음.
- 작업자의 승인 요청(Claude permission-prompt-tool, Codex requestApproval) 처리 순서:
  1. 읽기 전용 도구(Read/Grep/Glob 등)는 판단 없이 허용 (비밀 파일 제외).
  2. 사용자가 "이 채팅 동안 허용"한 종류, 또는 판단기가 이미 허용한 똑같은 작업은 그대로 허용.
  3. **판단기**: 채팅마다 마스터와 같은 CLI·모델로 도는 별도 대화(도구 없음, 읽기 전용, 저장 안 함). 마스터 본 세션은 협의 도구 호출 안에서 멈춰 있으므로 따로 둔다. 사용자 지시, 진행 중인 협의 요청, 요청한 작업자, 정확한 작업(명령/경로/diff 요약), 자동 위험 분류를 받고 `{"decision":"allow"|"deny"|"ask_user","reason":"..."}` 한 줄로 답한다. 형식이 틀리거나 2분 안에 답이 없으면 사용자에게 묻는다. 거부 이유는 작업자에게 돌려줘서 방법을 바꾸게 한다.
  4. **고위험 하한선**: 작업 폴더 밖 쓰기, 재귀 삭제, git push·기록 변경, 비밀·자격 증명 접근, 시스템·레지스트리 변경, 네트워크 업로드는 판단기가 허용해도 사용자 카드로 보낸다(판단기의 의견 표시). 판단기가 거부하면 바로 거부. 프로젝트 설정 "고위험 요청도 마스터에 맡기기"(기본 끔)로 위임 가능.
- 화면: 자동 판단은 타임라인/협의 카드 안에 한 줄("✓ 마스터 승인 · Claude · Edit … — 이유", 눌러서 상세). 사용자에게 넘어온 요청은 기존 3버튼 카드 + 판단기 의견.
- 기록: approvals 표에 decided_by(auto/user-memo/orchestrator/orchestrator-memo/user)와 이유를 남김. 판단 호출은 협의 횟수 한도에 들어가지 않음.

## 2-4. 트레이 · 중단 복구 (v0.2.1)
- 작업 중에 창을 닫으면 앱과 CLI는 트레이에서 계속 실행("작업 중 N개" 툴팁). 끝나거나 승인·질문이 필요하면 알림(누르면 해당 채팅). 진짜 종료는 트레이 메뉴 또는 파일 > 종료(Ctrl+Q), 작업 중이면 "진행 중인 작업이 중단됩니다" 확인.
- 앱이 작업 중에 종료되거나 꺼지면 다음 실행 때 그 채팅은 **중단됨**, 진행 중이던 협의는 중지됨. 채팅의 **이어서 진행**은 마스터 세션을 이어(--resume / thread/resume) "작업 폴더 상태(git status·diff)를 확인하고 남은 작업을 끝내라"와 원래 지시를 보낸다. 작업자는 다음 협의 때 자기 세션을 이어 씀.
- 실행은 데이터 폴더당 하나: 0.2.1부터 단일 인스턴스 잠금, 그리고 잠금이 없는 0.2.0이 같은 데이터 폴더(--user-data-dir)로 떠 있으면 새 창을 열지 않고 "이전 버전이 실행 중입니다"(이전 창 보기 / 다시 시도 / 이전 버전 종료 후 열기[진행 중 작업이 없을 때만, 정상 종료 요청] / 닫기). DB를 열기 전에 확인한다.
- 브리지 MCP의 앱 호출은 시간 제한 없음(협의·승인 대기는 5분을 넘길 수 있음). 마스터가 먼저 끝나도 작업자가 남아 있으면 채팅은 "작업 중"을 유지.

## 2-5. 남은 사용량 (v0.2.1)
- 공급자별로 **주간 남은 사용량**(100 − 사용률)을 표시하고, 5시간 창의 남은 양이 10% 이하가 되면 그 동안만 5시간 값을 경고색으로 표시. 주간 정보가 없으면 5시간 값 + "주간 정보 없음".
- Claude: stream-json `rate_limit_event.rate_limit_info.unifiedWindows.{five_hour, seven_day}`(utilization 0–1). Codex: `account/rateLimits` primary/secondary를 `windowDurationMins`로 5시간/주간 구분. 마지막 값은 저장해 다음 실행 때 바로 표시. 선택 규칙은 `src/shared/usage.ts` + 단위 테스트.

## 2-6. 슬래시 명령 (v0.3.0)
입력창에 `/`를 치면 명령 목록(입력으로 거르기, ↑↓·Enter/Tab 선택, Esc 닫기)이 뜬다. 모르는 `/명령`은 모델에 보내지 않고 "알 수 없는 명령"으로 알린다.

| 명령 | 동작 |
|---|---|
| `/plan <지시>` | 마스터가 읽기 전용으로 조사하고 **계획만** 세움(이 동안 협의 도구는 거절). 계획은 상단 고정 체크리스트 카드로 표시되고 **실행 / 수정 요청 / 취소** 버튼. 실행하면 계획대로 위임하며 체크리스트가 실시간으로 갱신됨 |
| `/goal <목표>` · `/goal` · `/goal clear` | 채팅 목표를 정해 상단에 고정(상태·진행 메모). 마스터는 `update_goal` 도구로 진행을 보고하고, 턴이 끝나도 목표가 진행 중이면 자동으로 이어서 진행(최대 6번, 협의·시간 한도와 자동 승인 규칙은 그대로). `/goal`만 치면 현재 목표, `clear`는 삭제 |
| `/review [요청]` | 커밋되지 않은 변경(git status·diff)을 변경을 만들지 않은 작업자에게 리뷰 맡김 |
| `/status`, `/model` | 채팅 상태 창: 세 모델(바로 변경 가능), 각 대화 id, 승인 방식, 목표, 남은 사용량 |
| `/new` | 같은 프로젝트에 새 채팅 |
| `/stop` | 중지 |
| `/compact` | 마스터 대화 압축 (Codex: `thread/compact/start`, Claude: Claude Code의 `/compact`) |

Codex 자체 구현과의 대응:
- Codex `/plan` = 협업 모드 `plan`(`turn/start`의 `collaborationMode`, app-server **실험 API**)과 내장 `update_plan` 체크리스트(`turn/plan/updated`, `plan` 항목). 안정 API만 쓰려고 실험 모드 대신 **계획 전용 턴 + 네이티브 체크리스트**로 구현했다. GPT 마스터는 `update_plan` → `turn/plan/updated`, Claude 마스터는 `TodoWrite`. 둘 다 `plan_update` 이벤트로 정규화해 같은 카드에 표시한다.
- Codex `/goal` = `thread/goal/set|get|clear`. 스레드에 붙는 지속 목표로, 상태(active/paused/blocked/usageLimited/budgetLimited/complete)와 토큰 예산·사용량을 가진다. 두 마스터가 똑같이 동작하도록 앱이 목표를 들고(`chats.goal_json`) 마스터 도구 `update_goal`(active/complete/blocked + progress)로 상태를 받는다. 이어서 진행하는 횟수는 앱이 제한한다.
- TUI 전용 명령(/init, /diff 화면, /mention, /approvals 화면 등)은 GUI에 이미 같은 기능이 있거나 의미가 없어 넣지 않았다.

## 3. 프로젝트 · 채팅 · 트리
```
📁 프로젝트(이름 + 작업 폴더 필수 + 설정: 리드, Claude 모델, Codex 모델, 권한 모드, 리뷰 게이트, 한도)
  💬 채팅(상태 아이콘)
     ◆ 리드 대화(원본 전체 기록) ◆ Codex 대화 ↔ 협의 N · 종류 · 결과(✓/진행 중)
  + 새 채팅
+ 새 프로젝트
```
- 노드 클릭 → 오른쪽에 해당 화면(기본은 통합 채팅 타임라인). 상태: 작업 중/승인 필요/완료/오류. 우클릭: 이름 변경·삭제·보관.

## 4. 화면
왼쪽: 검색 + 트리 + 하단 상태(누가 작업 중) + 사용량(rate_limit_event, Codex rate limits).
오른쪽 상단 바: 채팅 제목 · 프로젝트, 리드 선택, 중지 버튼.
타임라인: 사용자 메시지(첨부 썸네일), 에이전트별 색·이름표 메시지(마크다운, 코드 하이라이트+복사, 표), 도구 호출은 접힌 카드, 파일 변경은 diff 보기, 협의는 접을 수 있는 카드(요청, Codex 실시간 출력, 변경 파일 +/-), 승인 카드 3버튼.
입력창: 📎, Ctrl+V 이미지·파일, 드래그 앤 드롭, 썸네일+삭제, Enter 보내기 / Shift+Enter 줄바꿈.
다크/라이트 테마, 한글 UI, 창 크기 기억.

## 5. 첨부
`%APPDATA%\AI_ChatterBox\attachments\<채팅 id>\`에 복사 보관. Claude: stream-json user message에 `{"type":"image","source":{"type":"base64","media_type":...,"data":...}}` 블록, 이미지 외 파일은 경로를 텍스트로 알리고 Read로 읽게 함. Codex: turn/start 입력의 `{"type":"localImage","path":...}` 항목(M0 spike/image-input.ts로 두 방식 모두 확인). 리드가 consult 시 attach로 첨부 전달.

## 6. 저장 (SQLite, v1 확장)
```
projects(id, name, folder, settings_json, created_at, archived)
chats(id, project_id, title, lead_agent, claude_session_id, codex_thread_id, status, created_at, last_active_at)
consults(id, chat_id, seq, from_agent, to_agent, kind, request, response_summary, files_changed_json, status, started_at, ended_at)
events(id, chat_id, node('lead'|'peer'|'consult:<id>'), ts, type, payload_json)
attachments(id, chat_id, event_id, path, mime, size)
approvals(id, chat_id, agent, action_json, risk, decision, scope('once'|'chat'), ts)
```
v1 세션은 "가져온 세션" 프로젝트 아래 채팅으로 이전.

## 7. 기술
유지: Electron 44, React 19, electron-vite, node:sqlite, ClaudeDriver, CodexDriver, portable exe.
추가: Tailwind + shadcn/ui, react-markdown + 하이라이트, 트리(react-arborist 또는 자체), diff 뷰어, Zustand. 새 모듈 Orchestrator, BridgeMcpServer, AttachmentStore.

## 8. 구현 순서
- **V1 화면과 구조**: 프로젝트(폴더)·채팅·트리, 마크다운·도구 카드·diff, 첨부(📎·Ctrl+V·드래그), 승인 카드 3단. 완료: 프로젝트 2개·채팅 여러 개 트리 탐색, 이미지 붙여넣어 Claude에 보내고 이미지 내용을 답함.
- **V2 협업**: Orchestrator, Bridge MCP consult_codex·ask_user, 협의 노드, 한도, 중지·추가 지시, 리드 전환. 완료: "이 버그 고쳐줘" 한 줄로 Claude가 Codex에 구현 위임 → 리뷰 → 최종 보고, 트리에 협의 노드 생성.
- **V3 마무리**: 사용량 표시, 검색, v1 데이터 이전, exe 빌드(v0.2.0), 실사용 점검 목록. 완료: exe로 위 시나리오 재현, 재실행 후 이어서 지시.

## 9. 기본값
리드 Claude, 코드 변경 시 끝내기 전 Codex 리뷰 1회 이상(끌 수 있음), 같은 폴더에서 차례로 작업(worktree 후순위), M1 드라이버·빌드 위에 새 UI와 Orchestrator.
