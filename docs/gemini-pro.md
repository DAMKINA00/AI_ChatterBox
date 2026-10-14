# Google AI Pro로 Gemini 작업자 사용

ChatterBox의 Gemini는 Google 계정으로 로그인한 **Antigravity CLI**를 사용합니다. 별도 Gemini API 키를 요구하지 않습니다.

## 설치와 로그인

1. [공식 설치 안내](https://antigravity.google/docs/cli/install/)에서 Windows CLI를 설치합니다.
2. PowerShell에서 `& "$env:LOCALAPPDATA\agy\bin\agy.exe"`를 실행하고 Google AI Pro 계정으로 로그인합니다. 브라우저에 인증 코드가 나오면 CLI 터미널에 직접 입력합니다.
3. `& "$env:LOCALAPPDATA\agy\bin\agy.exe" models`에 모델 목록이 나오면 준비가 끝납니다.
4. ChatterBox 프로젝트 설정에서 Gemini 모델을 선택합니다. 기본값은 **Pro 자동 선택**입니다. 마스터에게 “제미나이에게 이 문서 비교를 맡겨줘”처럼 요청할 수 있습니다.

전체 경로로는 실행되는데 PowerShell에서 `agy`를 찾지 못하면 사용자 환경 변수 `Path`에 `%LOCALAPPDATA%\agy\bin`이 빠졌는지 확인하고 등록합니다. 이미 열린 터미널에는 이전 PATH가 남을 수 있으므로 새로 실행하거나, 현재 PowerShell에서 다음을 실행합니다.

```powershell
$env:Path += ";$env:LOCALAPPDATA\agy\bin"
agy --version
```

0.3.8부터 상단 설치 경고의 **설치 경로 다시 확인**으로 앱을 종료하지 않고 다시 검사할 수 있습니다. 설치 후 앱으로 돌아오거나 모델의 **목록 다시 확인**을 눌러도 설치 경고가 함께 갱신됩니다. 실행 파일이 발견돼도 로그인·네트워크 문제가 있으면 모델 메뉴에 별도 오류로 표시합니다.

## 모델 목록과 남은 사용량 (0.3.6)

모델 조회가 일시적으로 실패하면 메뉴를 다시 열 때 재시도합니다. 메뉴 안의 **목록 다시 확인**으로도 재시도할 수 있습니다. Windows에서는 PATH와 LOCALAPPDATA뿐 아니라 현재 사용자 프로필의 기본 설치 폴더도 확인합니다. CLI 탐색 실패와 로그인·네트워크 조회 실패는 구분해서 표시합니다.

왼쪽 아래에 **Claude · GPT · Gemini**의 남은 사용량을 표시합니다. Gemini는 Antigravity의 `agy -p /usage --output-format json`에서 **Gemini Models** 그룹의 주간·5시간 한도만 가져옵니다. 주간 잔여량을 기본으로 보여주고 5시간 잔여량이 10% 이하이면 해당 한도로 전환합니다. 마우스를 올리면 초기화 시간과 조회 시각을 볼 수 있습니다. 앱 시작과 5분마다 갱신하고 마지막 정상 조회는 재실행 후 복원합니다. 조회 실패 시 이전 비율을 현재 값으로 표시하지 않고 **조회 실패**로 표시합니다.

CLI 1.3.5에서 실제 Pro 계정의 모델 3개와 두 한도를 확인했습니다. 이 조회는 CLI 자체 명령으로 모델 작업을 시작하지 않습니다(`num_turns: 0`, 사용 토큰 0). 명령 형식이 없는 구버전은 정보를 추정하지 않으며 CLI 업데이트가 필요합니다. [공식 headless 안내](https://antigravity.google/docs/cli/headless/), [모델 한도 안내](https://antigravity.google/docs/cli/commands/usage/).

2026-10-14에 실제 Pro 계정과 CLI 1.3.4에서 확인한 모델은 Gemini 3.8 Flash High·Medium·Low입니다. Pro 자동 선택은 Flash Medium을 기준으로 모델 계열을 선택하며 계정이 제공하는 목록을 실행 전에 다시 검사합니다. 특정 모델을 지정했는데 사라졌다면 다른 계열로 바꾸지 않고 오류를 표시합니다. 제공 모델은 Google 정책과 계정에 따라 달라질 수 있습니다.

## 추론 수준과 작업 시간 (0.3.5)

작업자의 기본 추론 설정은 **자동 배정**입니다. 마스터가 협의마다 지원되는 `medium` 또는 `high`를 선택하고 이유를 기록합니다. 사용자가 직접 추론 수준을 고르면 그 값을 우선 적용하며, 같은 모델 계열의 해당 CLI 변형(예: `gemini-3.8-flash-high`)을 실행합니다. 현재 Pro 목록에 `xhigh`가 없으므로 잘못 요청된 `xhigh`는 지원되는 `high`로 낮추고 협의 기록에 요청값·적용값을 함께 남깁니다. 메뉴에 지원되지 않는 수준을 새 선택지로 표시하지 않습니다.

새 프로젝트의 기본 인원은 클로드 3명·지피티 3명·제미나이 1명입니다. 지시와 협의의 앱 시간 제한은 없으며 필요하면 중지 버튼을 사용합니다. CLI 자체의 연결·도구 시간 제한과 계정 사용 한도까지 없애는 기능은 아닙니다.

## 승인과 작업 범위

공식 [PreToolUse hook](https://antigravity.google/docs/hooks/)으로 파일·명령 요청을 ChatterBox 승인 처리에 전달합니다. 일반 구현은 지정한 범위 안에서 수행하며 리뷰·의견은 변경을 거부합니다. 승인 연결이 끊기면 hook은 거부를 반환합니다. 네이티브 하위 에이전트, 임의 MCP, 브라우저·이미지 생성 도구는 열지 않습니다. Windows 관리자 권한과 앱의 작업 승인은 별개입니다.

명령·파일 변경과 실시간 대사는 기존 협의 카드에 표시됩니다. 출력 토큰에는 생각 토큰을 포함하며 속도는 도구·승인 대기를 포함한 턴 평균입니다. 순수 모델 생성 속도나 Google 계정의 잔여 할당량이 아닙니다.

## 이번 버전의 범위

- Gemini는 작업자이며 마스터 모델은 Claude/Codex입니다. 일반 업무는 Claude 우선, 이미지 생성은 GPT, 중요한 오류는 Claude와 GPT의 독립 조사 기준을 유지합니다.
- 아이콘은 별 모양 대신 제미나이 전용 치비 캐릭터 12종(중립 포함)으로 표시합니다.
- CLI 제어 설정은 ChatterBox 임시 데이터 아래 `AI AGENT` 폴더에 생성하고 실제 작업 폴더를 별도로 전달합니다. 이것은 Antigravity 앱의 이름 있는 프로젝트 생성과는 다릅니다.
- ChatterBox 기록 저장·작업자 해제·재호출은 지원합니다. CLI 1.3.4의 공식 [대화 관리](https://antigravity.google/docs/cli/conversations/)와 [명령 참조](https://antigravity.google/docs/cli/reference/)에서 보관·복원 기능을 확인하지 못했습니다. 내부 SQLite와 색인을 임의로 바꾸거나 원본 대화를 삭제하지 않으며, Claude/Codex와 같은 원본 목록 자동 보관은 지원하지 않습니다.
- Google AI 구독을 변경하거나 추가 크레딧을 구매하지 않습니다. 사용자 CLI에 별도 API 공급자가 설정되어 있으면 구독 로그인을 사용하는 상태로 돌린 뒤 이용하세요.
