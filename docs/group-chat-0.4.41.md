# AI ChatterBox 0.4.41 — 그룹 토의와 배정·무응답 처리

2026-11-09 통합 기록. GitHub `main / 7646ff8`의 최신 상태를 fetch와 원격 HEAD 조회로 확인한 뒤, 미커밋 0.4.40 개발본의 그룹 채팅·배정·복구·승인 수정을 0.4.41로 통합했다. NAS `origin`은 인증 실패로 최신 상태를 확인하지 못했다. 기존 `output/`은 보존하고 커밋에서 제외한다. 원격 게시·설치는 이번 로컬 통합 커밋과 구분한다.

## 바뀐 대화 방식

사용자 지시는 기존 마스터가 받되, 마스터가 모든 동료 발언을 중계하지 않도록 기존 협업 엔진을 확장했다.

- `send_message(to="all", message=...)`은 공용 그룹 발언이다. 전체 대화·마스터·개별 동료 화면에서 발언자의 이름으로 표시하며, 같은 채팅의 동료들은 받은 메시지를 독립적으로 확인한다.
- 동료끼리 `ask`/`ask_parallel`로 직접 질문하고 답을 받는다. 작업자가 토의 그룹을 구성하거나 질문의 작업 종류를 선택하는 것을 마스터 전용 규칙으로 제한하지 않는다. 진행자는 약속한 참여자의 실제 답을 받아야 토의 완료로 인정된다.
- 각 협의의 결과도 공용 대화에 공유한다. 긴 결과는 공용 메시지에서 4,000자로 줄이고 원문은 기존 협의 기록에 보존한다.
- 실행 중인 동료에게는 즉시 전달을 시도한다. 사용자 승인·도구 실행·동료 응답을 기다리는 동안에는 받은 편지함에 보관하고 다음 도구 응답/작업 시작에서 전달한다. Claude의 우선 입력이 실행 중인 도구를 취소할 수 있어, 동료 발언으로 협의 호출이 끊기지 않게 했다.
- 공용 발언만으로 모든 대기 모델을 자동 실행하지 않는다. 실제 답이 필요한 동료에게 직접 질문한다. 동일 발언 중복, 자기 호출, 순환 대기와 겹치는 쓰기 범위의 충돌 방지는 유지한다.

## 상황에 맞는 배정

특정 종류의 업무를 무조건 특정 모델 계열에 맡기라는 지시를 없앴다. 마스터와 동료는 실제 도구·기존 맥락·난도·속도·비용·계정 가용성으로 담당과 진행 순서를 선택한다. 사용자가 명시한 담당·수동 추론 설정·비활성 계열·계정 정책은 계속 우선한다.

- `route_request`가 `availableModels`와 모델이 보고한 추론 수준 전체를 제공한다.
- `ask`와 `ask_parallel`은 선택적인 `model`과 `effort`를 받는다. 실제 실행할 계정에서 모델과 추론 수준을 확인한다. 배정별 모델 선택은 저장된 프로젝트 모델을 변경하지 않는다.
- 동료도 질문마다 추론 수준을 선택할 수 있다. `medium/high/xhigh`만 허용하던 제약을 없앴고, 생략하면 기존 배정 또는 모델 기본값을 사용한다. 지원하지 않는 값은 모델 검증에서 처리한다.
- 작업자 수·배정 횟수·리뷰 횟수는 계획 참고값으로 바꿨다. 설정 화면의 문구도 맞췄다. 선택 계열의 인원이 참고값을 넘거나 배정/리뷰 횟수를 소진했다는 이유로 미완료 작업을 차단하지 않는다. 계열 인원 `0`은 명시적 비활성 상태로 유지한다.
- Gemini 웹과 AI Studio의 전환은 기존 채팅 설정을 따른다. 웹 모델에 로컬 도구가 있다고 가정하지 않는다.

## 무응답을 다시 확인하는 경로

기존 자동 복구는 명시적 오류가 있는 작업만 확인했다. 오류 없이 조용해진 작업은 마스터가 계속 기다릴 수 있었다.

현재는 5분 이상 활동이 없으면 앱이 그룹 대화에 상태 점검을 알리고 마스터의 협의 결과 대기를 풀어 준다. 이는 실패 판정이나 강제 종료가 아니다. 긴 명령, 모델 추론, 동료 응답 대기를 구분해서 확인한다.

`check_agent(to=닉네임)`은 마지막 활동 이후 시간, 네이티브 실행 여부, 미완료 도구 수, 오류, 최근 결과를 반환하고 진행 질문을 전달한다. 이미 배정한 작업에도 반복해서 사용할 수 있다. `agents` 목록에서도 마지막 활동과 점검 가능 여부를 볼 수 있다.

마스터의 `check_agent(to=닉네임, recover=true)`는 기존 실행의 중지 완료를 확인한 뒤 실패로 정리한다. 기존 파일과 대화는 보존하며, 이후 `supersedes`로 원래 작업을 이어 맡길 수 있다. 종료 확인에 실패하면 쓰기 범위를 해제하거나 같은 파일을 다른 작업자에게 넘기지 않는다.

Codex는 계정별 서버를 여러 작업자가 공유하므로 해당 턴의 중지와 종료 이벤트만 확인한다. 한 작업자의 복구 때문에 공유 서버를 강제 종료하지 않는다. 중지 확인이 불가능하면 복구 실패를 명시하고 기존 실행과 범위를 유지한다.

## Computer Use 승인 누락 수정

`src/main/drivers/codex.ts`는 `mcpServer/elicitation/request`를 처리하지 않아 `-32601 / AI_ChatterBox does not handle ...` 오류를 반환하는 구조였다. 현재는 이 요청을 기존 중앙 승인 서비스에 연결한다.

| 설정/상태 | 앱 접근 요청 처리 |
| --- | --- |
| 전체 승인 | 자동 허용하고 승인 이력에 기록 |
| 마스터 자동 판단 또는 관리자 직접 승인 | 기존 사용자 승인 카드로 확인 |
| 사용자의 거부 | `decline` |
| 작업 중지·승인 취소·승인 연결 오류 | `cancel` |
| 명시적인 읽기 전용 실행 | 허용하지 않음 |

지원 대상은 앱 접근 확인용 `form`이다. 입력이 없는 확인 양식 또는 필수 필드가 일회 승인 선택을 제공하는 양식을 처리한다. 암호·자유 입력·URL 로그인·다른 확장 양식에 임의의 값을 만들어 응답하지 않는다. 앱 접근 요청은 채팅 전체 허용을 재사용하지 않고 네이티브 영구 승인 값도 보내지 않는다. 전체 승인 설정이 있는 경우에만 사용자 승인 카드 없이 앱 접근을 허용한다.

## OpenMausBot에서 활용할 부분

검토한 소스는 [OpenMausBot 커밋 `3f815766`](https://github.com/milind-soni/OpenMausBot/tree/3f81576655ca45af91bfaaa63dc37251222828eb)이다. 별도 앱 전체를 ChatterBox의 의존성으로 추가하지 않고, 현재의 세션·DB·승인·파일 잠금에 대화방 개념을 적용하는 것이 이번 요구에 맞는다.

| 참고한 구현 | ChatterBox에서의 활용 |
| --- | --- |
| [room-queue.ts](https://github.com/milind-soni/OpenMausBot/blob/3f81576655ca45af91bfaaa63dc37251222828eb/server/room-queue.ts), [room-member-lock.ts](https://github.com/milind-soni/OpenMausBot/blob/3f81576655ca45af91bfaaa63dc37251222828eb/server/room-member-lock.ts) | 대기 중과 실제 실행 중을 구별한다. 현재의 작업자 큐·순환 대기 검사·파일 범위 잠금을 재사용한다. |
| [agents-call.ts](https://github.com/milind-soni/OpenMausBot/blob/3f81576655ca45af91bfaaa63dc37251222828eb/server/drivers/agents-call.ts) | 동료에게 직접 맡긴 작업과 그 상태를 조회하는 개념. 이번 `check_agent`와 공용 결과 공유에 적용했다. |
| [room-reply.ts](https://github.com/milind-soni/OpenMausBot/blob/3f81576655ca45af91bfaaa63dc37251222828eb/server/room-reply.ts) | 모든 모델이 매번 발언할 필요 없이 필요한 동료가 실제 결과를 낸다. 공용 메시지 도착만으로 전원을 자동 실행하지 않는다. |
| [room-context.ts](https://github.com/milind-soni/OpenMausBot/blob/3f81576655ca45af91bfaaa63dc37251222828eb/server/room-context.ts) | 향후 장기 토의의 동료별 컨텍스트 측정·요약 정책에 참고할 수 있다. 이번에는 별도 컨텍스트 관리 계층을 추가하지 않았다. |
| [codex-app-approval.ts](https://github.com/milind-soni/OpenMausBot/blob/3f81576655ca45af91bfaaa63dc37251222828eb/server/drivers/codex-app-approval.ts) | 일반 입력 양식과 일회 앱 접근 승인을 구별한다. ChatterBox의 기존 승인기를 사용해 필요한 프로토콜 경로를 구현했다. |
| [room-post-budget.ts](https://github.com/milind-soni/OpenMausBot/blob/3f81576655ca45af91bfaaa63dc37251222828eb/server/room-post-budget.ts) | 반복 발언과 루프를 구별하는 참고 자료다. 사용자의 요청에 맞춰 고정 발언 횟수 제한은 이식하지 않았다. |

[프로젝트 라이선스 안내](https://github.com/milind-soni/OpenMausBot/blob/3f81576655ca45af91bfaaa63dc37251222828eb/LICENSING.md)는 일반 소스와 `enterprise/`의 조건을 구분한다. 이번에는 외부 소스나 패키지를 제품에 복사·번들하지 않았다. 가상 PC·클라우드 실행·외부 서비스 연결은 이번 대화 구조 개선과 분리해 후속 검토할 수 있다.

## 0.4.40 개발본의 동작 검증 (2026-11-08)

- Node/Web TypeScript 타입 검사 통과.
- 단위·통합 테스트 531/531 통과. 승인 허용·거부·취소·전체 승인·읽기 전용, 모델/추론 선택, 공용 메시지 전달, 무응답 점검·복구와 기존 계정·파일 범위 동작을 포함한다.
- 격리 Electron UI 검사 25/25 통과. 실제 앱 접근 승인 문구, 일회 승인 전달, 영구 승인 버튼 비활성, 공용 발언의 위치, 개별 동료 화면, 밝은/어두운 테마와 좁은 화면을 확인했다.
- 최종 Windows 패키지(`dist/win-unpacked/AI_ChatterBox.exe`)에서도 같은 화면 검사 25/25 통과. 패키지의 빌드 출력 174개를 현재 `out/`과 비교해 모두 일치했고, 버전 0.4.40과 승인·그룹 메시지·상태 확인·모델 선택 처리의 포함을 확인했다.
- 실제 Claude/Codex CLI와 별도 DB로 합성 문구 토의를 실행해 10/10 검사를 통과했다. 진행자가 초안을 공개하고 Codex 동료의 반론을 직접 받아 최종 문구를 수정했으며, 양쪽 공개 발언·실제 응답·마스터의 최종 취합을 확인했다. 테스트는 제품 파일을 수정하지 않았다.
- 최초 실제 토의에서 동료 우선 입력이 대기 중인 협의를 끊는 문제가 드러나, 대기 중에는 받은 편지함에 보관하도록 수정한 뒤 재검증했다.
- 사용자의 실제 Computer Use 대상 앱으로 권한을 요청하고 조작하는 검사는 하지 않았다. 승인 프로토콜과 UI 연결 검증을 실제 OS 앱 접근 성공으로 확대 해석하지 않는다.
- 기존 실행 중 앱·사용자 DB에 새 버전을 설치하거나 원격에 게시하는 단계는 별개다. 이번 소스와 빌드 산출물을 확인한 뒤 적용할 수 있다.

증거는 `D:\AI\AI_ChatterBox\.scratch\chatterbox-20261108-tests.log`, `chatterbox-20261108-ui.log`, `chatterbox-20261108-packaged-ui.log`, `chatterbox-20261108-live.log`, `chatterbox-20261108-package-check.json`과 같은 폴더의 `peer-discussion-live-1794109899416/results.json`에 있다. 최종 패키지 화면 자료는 `.scratch/pending-approvals-ui/1794110224523/screenshots/`에 있다.

## 0.4.41 통합 검증 (2026-11-09)

기존 개발본의 동작 변경을 통합하고 package.json과 package-lock.json의 버전을 0.4.41로 맞췄다.

- Node/Web TypeScript 타입 검사 통과.
- 단위·통합 테스트 531/531 통과.
- 0.4.41 Windows 패키지로 격리 Electron UI 검사 25/25 통과.
- 패키지 버전 0.4.41을 확인하고 빌드 출력 174개를 `out/`과 비교해 모두 일치했다. Computer Use 승인·그룹 메시지·상태 확인·모델 선택 처리의 포함을 재확인했다.
- 실제 CLI 토의는 앞 절의 0.4.40 개발본에서 검증한 결과를 유지한다. 이번 통합에서 동작 코드를 추가로 변경하지 않았으므로 다시 실행하지 않았다. 실제 Computer Use 대상 앱 접근 검증은 여전히 미실시다.
- 검증 로그는 `.scratch/chatterbox-0.4.41-typecheck.log`, `chatterbox-0.4.41-tests.log`, `chatterbox-0.4.41-ui.log`, `chatterbox-0.4.41-package-check.json`에 있다.

기존 `dist/win-unpacked` 앱이 실행 중이어서 패키징 출력은 별도 `dist/0.4.41`로 분리했다. 실행 중인 앱은 종료하지 않았다. 설치 파일 경로는 `D:\AI\AI_ChatterBox\dist\0.4.41\AI_ChatterBox-0.4.41-setup.exe`다. 이번 작업에서는 원격 푸시·태그·게시·설치를 실행하지 않는다.

AIUsageMonitor는 `build/usage-monitor.json`에 고정된 `17b3005738a1fdc7662965d909eb5a87da7efa4d`의 별도 소스로 빌드한다. 현재 개발 중인 다른 AIUsageMonitor 소스의 커밋을 변경하거나 고정 버전 확인을 건너뛰지 않는다.
