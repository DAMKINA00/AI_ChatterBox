# Google AI Pro로 Gemini 작업자 사용

ChatterBox 0.3.4의 Gemini는 Google 계정으로 로그인한 **Antigravity CLI**를 사용합니다. 별도 Gemini API 키를 요구하지 않습니다.

## 설치와 로그인

1. [공식 설치 안내](https://antigravity.google/docs/cli/install/)에서 Windows CLI를 설치합니다.
2. PowerShell에서 `& "$env:LOCALAPPDATA\agy\bin\agy.exe"`를 실행하고 Google AI Pro 계정으로 로그인합니다. 브라우저에 인증 코드가 나오면 CLI 터미널에 직접 입력합니다.
3. `& "$env:LOCALAPPDATA\agy\bin\agy.exe" models`에 모델 목록이 나오면 준비가 끝납니다.
4. ChatterBox 프로젝트 설정에서 Gemini 모델을 선택합니다. 기본값은 **Pro 자동 선택**입니다. 마스터에게 “제미나이에게 이 문서 비교를 맡겨줘”처럼 요청할 수 있습니다.

2026-10-14에 실제 Pro 계정과 CLI 1.3.4에서 확인한 모델은 Gemini 3.8 Flash High·Medium·Low입니다. 기본은 Medium이며 계정이 제공하는 목록을 실행 전에 다시 검사합니다. 특정 모델을 지정했는데 사라졌다면 다른 모델로 몰래 바꾸지 않고 오류를 표시합니다. 제공 모델은 Google 정책과 계정에 따라 달라질 수 있습니다.

## 승인과 작업 범위

공식 [PreToolUse hook](https://antigravity.google/docs/hooks/)으로 파일·명령 요청을 ChatterBox 승인 처리에 전달합니다. 일반 구현은 지정한 범위 안에서 수행하며 리뷰·의견은 변경을 거부합니다. 승인 연결이 끊기면 hook은 거부를 반환합니다. 네이티브 하위 에이전트, 임의 MCP, 브라우저·이미지 생성 도구는 열지 않습니다. Windows 관리자 권한과 앱의 작업 승인은 별개입니다.

명령·파일 변경과 실시간 대사는 기존 협의 카드에 표시됩니다. 출력 토큰에는 생각 토큰을 포함하며 속도는 도구·승인 대기를 포함한 턴 평균입니다. 순수 모델 생성 속도나 Google 계정의 잔여 할당량이 아닙니다.

## 이번 버전의 범위

- Gemini는 작업자이며 마스터 모델은 Claude/Codex입니다. 일반 업무는 Claude 우선, 이미지 생성은 GPT, 중요한 오류는 Claude와 GPT의 독립 조사 기준을 유지합니다.
- 아이콘은 제미나이를 식별하는 별 모양입니다. 기존 세 캐릭터의 치비 이미지와 구분합니다.
- CLI 제어 설정은 ChatterBox 임시 데이터 아래 `AI AGENT` 폴더에 생성하고 실제 작업 폴더를 별도로 전달합니다. 이것은 Antigravity 앱의 이름 있는 프로젝트 생성과는 다릅니다.
- ChatterBox 기록 저장·작업자 해제·재호출은 지원합니다. Antigravity 원본 대화를 자동 보관하는 API는 연결하지 않았으므로 Claude/Codex와 같은 원본 목록 보관을 보장하지 않습니다.
- Google AI 구독을 변경하거나 추가 크레딧을 구매하지 않습니다. 사용자 CLI에 별도 API 공급자가 설정되어 있으면 구독 로그인을 사용하는 상태로 돌린 뒤 이용하세요.
