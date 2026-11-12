# ChatterBox ↔ AI 사용량 모니터 호스트 규약 (계정 연동)

ChatterBox는 AI 사용량 모니터(`AIUsageMonitor.exe --hosted`)를 자식 프로세스로 실행하고, 표준 입출력으로 한 줄에 JSON 하나씩 주고받습니다(UTF-8, `\n`으로 끝남, 줄당 64KB 미만). 기존 명령(`show`, `topmost` 등)과 상태 보고(`state`, `notification`, `error`)는 그대로입니다. 이 문서는 계정 연동을 위해 추가한 부분입니다.

## 원칙
- 계정의 단일 출처는 ChatterBox CLI 계정 저장소입니다. 계정 목록·순서·라벨·배정 제외·로그인 상태, 계정별 사용량(잔여·창·리셋·조회 시각), 딥시크 잔고를 ChatterBox가 보냅니다.
- 호스트 모드의 모니터는 자기 계정 목록, 로그인, 사용량 조회를 쓰지 않습니다. Claude 웹·데스크톱, Codex app-server, Grok CLI 조회와 추가 계정이 모두 꺼집니다.
  - 이 PC의 작업 활동(세션 파일)은 캐릭터 상태와 작업 알림용으로 계속 읽습니다.
  - 표시(캐릭터, 작업표시줄, 카드)와 알림(사용량 80/95% 등 모니터 자체 임계값)은 모니터가 맡습니다.
- 단독 실행(`--hosted` 없이)은 예전과 같습니다. 모니터 자체 설정과 계정으로 동작합니다.
- 보내는 것은 계정 id, 라벨, 플래그, 수치뿐입니다. 이메일·토큰·API 키·폴더 경로는 보내지 않습니다.
- 이 규칙은 원격 웹 `/api/usage`에도 똑같이 적용합니다(`publicUsageGroups`). 데스크톱 앱 화면은 원래 문구와 라벨을 그대로 보여 줍니다.
- **오류:** 원문은 보내지 않습니다. 토큰·경로·이메일·URL이 들어 있을 수 있기 때문입니다. 아래 코드(`errorCode`) 중 하나로 분류하고 그 고정 문구(`error`)만 보냅니다.

  | 코드 | 문구 | 분류 기준(원문) |
  |---|---|---|
  | `not_installed` | CLI를 찾지 못했습니다 | 찾지 못·설치·not found·ENOENT |
  | `rate_limited` | 조회 한도에 걸렸습니다. 잠시 뒤 다시 조회합니다 | 429·rate limit |
  | `login_required` | 로그인이 필요합니다 | 로그인·인증·sign in·unauthorized·forbidden·401/403·auth |
  | `timeout` | 조회 시간이 초과되었습니다 | timeout·시간 초과 |
  | `network` | 네트워크 오류로 조회하지 못했습니다 | ECONN·ENOTFOUND·network·fetch failed |
  | `failed` | 사용량 조회에 실패했습니다 | 그 밖의 모든 오류 |

  딥시크 잔고 오류도 같은 문구로 보냅니다.
- **라벨:** 아래처럼 보이는 라벨은 `계정 N`(N은 계정 번호, 예: `gpt-3` → `계정 3`)으로 바꿔 보냅니다.
  - 이메일(`@`)
  - 경로(`\`, `/`, `C:`, `~`)
  - URL(`http(s):`, `www.`)
  - 토큰: `sk-`·`ghp_`·`xox?`·`AKIA` 같은 키 접두어, `Bearer`, 숫자와 문자가 섞인 20자 이상의 연속 문자열
  - 제어 문자가 든 라벨이나 빈 라벨
  - 그 밖의 라벨은 80자까지 그대로 보냅니다.

## 버전 확인
모니터는 `state`에 `accountsVersion: 1`을 넣어, 자신이 읽는 계정 메시지 버전을 알립니다. ChatterBox는 이 값이 자신의 `MONITOR_ACCOUNTS_VERSION`과 같을 때만 계정 메시지를 보냅니다. 이 값이 없는 예전 모니터에는 보내지 않습니다. 모니터는 다른 `version`의 메시지를 거부하고 `error`로 알립니다.

## ChatterBox → 모니터: `chatterbox-accounts`
```json
{"command":"chatterbox-accounts","value":{
  "version":1, "sentAt":1794484602516,
  "groups":[
    {"kind":"gpt","name":"지피티","accounts":[
      {"accountId":"gpt-1","kind":"gpt","label":"PREVATE","enabled":true,"isDefault":true,
       "authStatus":"authenticated","runningWorkers":0,
       "display":{"window":"주간","remaining":43,"resetsAt":1794700000,"warn":false},
       "checkedAt":1794484540000,
       "windows":{"fiveHour":{"usedPercent":12,"resetsAt":1794490000},"weekly":{"usedPercent":57,"resetsAt":1794700000}}}
    ]}
  ],
  "deepseek":{"state":"ready","balances":[{"currency":"USD","total":"5.20"}]}}}
```
- `groups`는 `src/shared/usage-view.ts`의 `usageGroups(cli-accounts:list, usage)` 결과입니다. 데스크톱 사용량 패널과 원격 웹 사용량 창이 쓰는 것과 같은 데이터입니다.
- 순서는 계정 저장소 순서이고, 모니터는 각 서비스의 첫 계정을 그 서비스 카드의 주 계정으로 씁니다.
- `enabled: false`는 ChatterBox에서 배정 제외된 계정입니다. 흐리게 표시하고 사용량 알림에서 뺍니다.
- `checkedAt`은 그 계정 값의 조회 시각(ms)입니다. 15분보다 오래되면 모니터가 "오래됨"으로 흐리게 표시하고, 그 값으로는 사용량 알림을 보내지 않습니다. 조회 시각이 없거나 1분 넘게 미래인 값도 알림에 쓰지 않습니다.
- 사용량 알림의 "이미 알림" 기록은 계정 id(`chatterbox:gpt-2`)로 남깁니다. 라벨은 알림 문구에만 씁니다. 그래서 라벨이 같은 두 계정도 각각 알림을 받고, 이름을 바꿔도 같은 주기에 다시 알리지 않습니다.
- 모니터가 표시하는 창은 ChatterBox와 같은 규칙으로 고릅니다(`shared/usage.ts`의 `pickUsage`).
  - 5시간 창이 10% 이하로 남았으면 5시간 창
  - 아니면 주간, 없으면 월간
  - 둘 다 없으면 5시간 창
- 시각 값(`resetsAt`, `checkedAt`)은 초 또는 밀리초를 받습니다.
- 모니터의 계정 id 형식은 `claude|gpt|grok-1..10`, 최대 60개입니다.

**보내는 시점(push):**
- 모니터가 시작해 첫 `state`를 보낸 직후(현재 스냅샷)
- 코어의 사용량 갱신 이벤트마다
- CLI 계정 추가·이름 변경·배정 제외·로그인·로그아웃·삭제 직후
- 짧은 간격의 여러 변경은 하나로 합쳐 보냅니다(300ms).
- 보내기 때문에 사용량을 다시 조회하지는 않습니다.

## 모니터 → ChatterBox: `refresh`
```json
{"type":"refresh"}
```
모니터의 새로고침(작업표시줄, 계정 패널)은 이 메시지만 보냅니다. ChatterBox가 계정 사용량을 다시 조회하고(`usage:get`), 갱신 이벤트에 따라 새 스냅샷을 보냅니다.

## 호스트 모드에서 거부하는 명령
`claude-login`, `claude-logout`, `claude-desktop`는 `error`("계정은 ChatterBox에서 관리합니다")를 돌려줍니다. ChatterBox 트레이 메뉴에서도 이 항목을 뺐고, "계정 관리"는 "계정별 사용량"(읽기 전용 패널)으로 바꿨습니다.

## 구현 위치
- ChatterBox:
  - 스냅샷 생성과 push: `src/main/usage-monitor-feed.ts`
  - 전송과 버전 확인: `src/main/usage-companion.ts`
  - 연결: `src/main/index.ts`
- 모니터:
  - 명령 파싱과 `refresh`: `Core/HostedProtocol.cs`
  - 스냅샷 해석: `Core/ChatterBoxAccounts.cs`
  - 카드·슬롯·계정 패널: `UI/Presenter.cs`(`Hosted`, `HostedAccountCards`)
  - 호스트 모드 연결: `App.xaml.cs`
  - 자체 조회 끄기: `Core/MonitorService.cs`(`UsageQueriesEnabled`)
- 별도 데이터 폴더(`AIUSAGEMONITOR_DATA_DIR`)로 실행한 모니터는 단일 실행 잠금도 따로 씁니다. 그래서 테스트나 임시 실행이 사용 중인 모니터와 충돌하지 않습니다.
