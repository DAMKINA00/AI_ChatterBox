# AI_ChatterBox v2 설계: 하나의 채팅, 두 에이전트 협업

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
- 채팅은 프로젝트 값을 상속. 채팅 상단 바에서는 **Claude 모델과 GPT 모델만** 채팅별로 바꿀 수 있고(오케스트레이터는 항상 프로젝트를 따름), "프로젝트 기본값" 표시와 "프로젝트 값으로 되돌리기"를 제공. 바꾸지 않은 값은 이후 프로젝트 변경을 따라가고, 바꾼 값은 유지. 변경은 다음 지시부터 적용.
- 오케스트레이터 도구(Bridge MCP): `consult_claude(message, kind, attach?)`, `consult_codex(message, kind, attach?)`, `ask_user(question, options?)`; kind = implement | review | opinion.
- 오케스트레이터는 **읽기 전용**: Claude는 쓰기·명령 도구 차단(`--disallowedTools`), Codex는 read-only 샌드박스 + 승인 요청 없음. 파일 수정은 작업자만, 한 번에 한 작업자.
- 기본 흐름: 오케스트레이터 계획 → 작업자 하나에 구현 위임 → 다른 작업자에게 리뷰 요청 → 수정 → 최종 보고. 누가 무엇을 할지는 오케스트레이터가 결정.
- 트리: 채팅 아래 `오케스트레이터 대화 · Claude 대화 · GPT 대화 · 협의 N`. 타임라인의 협의 카드에 "오케스트레이터 → GPT · 구현 위임"처럼 누가 누구에게 맡겼는지 표시.
- 한도(지시당 협의 8회, 리뷰 왕복 3회 등)는 두 작업자를 합쳐서 셈.

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
