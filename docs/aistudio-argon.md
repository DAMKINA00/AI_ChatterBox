# AI Studio · Argon

AI Studio · Argon은 ChatterBox의 Gemini 계열에서 Gemini Web과 나란히 선택하는 모델 경로입니다. Argon을 선택해도 기존 Gemini Web 계정 관리, 로그인 창, 웹 대화, 웹 사용량 표시는 그대로 유지됩니다. 프로젝트 또는 채팅의 모델 메뉴에서 **AI Studio · Argon 설정…**을 열고, 상태가 `RUNNING`이며 활성 계정의 모델 목록에 설정한 모델이 확인될 때 **Argon 모델 사용**을 선택합니다. 현재 선택 ID는 `aistudio:<model-id>`입니다.

## 설치

저장소 루트에서 다음 스크립트를 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-aistudio.ps1
```

스크립트는 실행할 때마다 GitHub의 공식 `releases/latest`에서 `windows-amd64.zip`을 찾아 내려받고, `C:\Apps\AIStudio2API\<version>`에 압축을 풉니다. 같은 버전 디렉터리가 있으면 덮어쓰지 않고 중단합니다. 릴리스가 SHA-256 digest 또는 대상 파일을 가리키는 checksum 항목을 반드시 제공해야 하며, digest가 없거나 비교값이 다르면 압축을 풀지 않습니다. `.env`가 없을 때만 다음 로컬 설정과 암호학적으로 생성한 `PROXY_API_KEY`를 기록합니다.

```text
LISTEN_ADDR=127.0.0.1:2048
AUTO_START=false
REQUEST_BODY_LOG=false
ADMIN_AUTH_ENABLED=false
WAA_BACKEND=go
MAX_ACTIVE_WORKERS=10
PER_ACCOUNT_CONCURRENCY=1
ROUTING_STRATEGY=fill-first
WARM_WORKER_LIMIT=2
UPSTREAM_CHANNELS=playground,build
```

API 키 값은 콘솔에 출력하지 않습니다. 기존 `.env`는 보존합니다. 서비스나 Google 로그인, 모델 생성은 설치 단계에서 실행하지 않습니다. 관리 프로그램만 숨겨진 창으로 시작하려면 다음을 사용합니다. 이미 `aistudio2api.exe` 프로세스가 있으면 새 프로세스를 만들지 않고 현재 프로세스도 종료하지 않습니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-aistudio.ps1 -Start
```

설치 후 **AI Studio · Argon 설정…**에서 백엔드 주소 `http://127.0.0.1:2048`, 설치된 `aistudio2api.exe`, 실제 모델 ID를 확인합니다. **서비스 시작**은 관리 화면에서 별도로 실행합니다. 첫 계정 로그인과 AI Studio 동의가 필요한 경우 사용자가 브라우저에서 직접 완료해야 합니다.

## Gemini Web 계정 연결

Google 로그인은 기존 **Gemini Web 계정 관리**에서 합니다. 로그인한 웹 계정 카드의 **AI Studio · Argon** 영역에서 **연결** 버튼을 누르면 같은 Google 계정을 로컬 AIStudio2API 계정으로 연결합니다. 선택한 Web 세션 상태는 로컬 AIStudio2API의 명시적 동기화 경로로 전달하며, ChatterBox 자체 저장소에는 원시 쿠키를 보관하지 않습니다. AI Studio의 최초 사용 동의나 보안 확인이 나타나면 자동으로 우회하지 않고 사용자가 처리합니다. 연결 결과·계정 상태·모델 가능 여부·실제 쿨다운만 표시합니다.

AI Studio 계정은 최대 10개입니다. 기본 설치 설정은 최대 Worker 10개, 계정별 동시 요청 1개, `fill-first` 계정 선택, 상주 warm Worker 2개입니다. 실제 AI Studio 쿨다운과 복구 시각은 카드에 표시하지만 웹 사용량처럼 퍼센트로 추정하지 않습니다. 웹 계정의 로그인·마스터 배정·웹 대화는 기존 흐름을 사용합니다.

## 다중 계정 처리

계정 로그인은 Gemini Web과 공유하고, AI Studio 요청의 계정 선택은 로컬 AIStudio2API가 처리합니다. ChatterBox에서 서비스를 시작하면 `fill-first`, 계정별 동시 요청 1개, 최대 활성 worker 10개를 적용합니다. 기본 설치의 warm worker 목표는 2개이며, 필요한 경우 다른 등록 계정도 활성화합니다.

1. 활성화되어 있고 요청한 모델을 지원하며 쿨다운이 아닌 계정·채널을 찾습니다. 준비된 계정을 먼저 사용하고, 필요하면 대기 계정을 활성화합니다. `fill-first`는 후보의 계정 ID와 채널 순서에서 처음 사용 가능한 조합을 우선 재사용합니다. 요청마다 계정을 균등하게 번갈아 쓰는 설정은 아닙니다.
2. 선택할 계정이 이미 요청 1개를 처리 중이면 다른 사용 가능한 계정으로 분산합니다. 전체 활성 worker 상한은 10개지만 실제 병렬 처리 수는 연결된 계정 수·모델 자격·쿨다운에 따라 줄어듭니다.
3. 429 한도 오류가 나면 계정·모델·채널 단위로 쿨다운을 기록합니다. 동일 계정에 다른 지원 채널이 남아 있으면 그 채널도 후보가 되며, 그렇지 않으면 다른 계정을 시도합니다. 계정 전체 제한이나 재인증이 필요한 상태는 제외합니다. 실제 계정·채널 선택은 각 모델의 지원 여부에 따릅니다.
4. 현재 설정은 `playground`, `build` 채널을 켭니다. `-build` 모델의 Build 대화 채널은 백엔드 통계에서 `assistant`로 구분됩니다. Gemini Web 사용량과 이 채널들의 사용량은 별도입니다.
5. 계정 전환 시 ChatterBox가 보관한 이전 메시지와 도구 결과를 요청에 함께 보내므로 대화 문맥을 이어갑니다. 한 계정의 Google 웹 대화 세션 자체를 다른 계정으로 옮기는 기능은 아닙니다.
6. 모든 계정이 바쁘면 대기합니다. 모두 쿨다운이면 백엔드는 가장 빠른 복구가 1분 이내인 경우 대기하고, 더 오래 걸리면 제한 오류를 반환합니다. 응답을 이미 보낸 뒤의 중단 등은 자동 재시도가 제한됩니다.

예를 들어 A 계정이 사용 중일 때 새 요청은 B 계정을 사용할 수 있습니다. A 계정의 Playground가 한도에 걸렸다면 지원되는 다른 채널 또는 B 계정으로 이어가며, A의 전체 한도를 합산해 새로운 한도로 만드는 방식은 아닙니다.

## AI Studio 전용 사용량

사이드바의 **AI Studio 사용량**은 최근 24시간의 요청 수와 총 토큰을 표시합니다. 클릭하면 설정 화면의 별도 사용량 패널에서 최근 **24시간·7일·30일**을 선택할 수 있습니다. 사이드바는 60초마다, 열린 상세 패널은 30초마다 갱신하며 **새로고침**으로 즉시 조회할 수도 있습니다.

로컬 AIStudio2API의 `/api/usage`가 제공하는 전체 요청·성공·실패·취소·429 제한 수, 입력·캐시·응답·추론·총 토큰을 표시합니다. 세부 집계는 **계정·모델·채널**별로 볼 수 있습니다. 이 백엔드를 이용하는 다른 클라이언트의 요청도 포함될 수 있으며, 일반 Gemini Web 대화의 사용량을 합치지 않습니다.

캐시 토큰은 입력 토큰에 포함됩니다. 요청 수는 도구 결과를 보내는 후속 요청까지 세므로 채팅 메시지 수와 다를 수 있습니다. 429 제한 건수는 실패 건수와 중복될 수 있습니다. 계정 전환 과정의 재시도는 별도 요청 수가 아니라 최종 요청의 내부 시도로 기록됩니다. 집계 기간은 요청 완료 시각 기준이며 계정 표는 요청 당시의 계정 이름으로 묶습니다.

이 사용 기록으로 Google 계정의 남은 횟수나 사용 가능 비율을 추정하지 않습니다. Google의 전체 잔여 한도는 이 API에서 제공하지 않으며, 기록이 없는 상태와 조회 실패도 구분해 표시합니다. 토큰에는 백엔드 추정값이 포함될 수 있고, 토큰 정보를 받지 못한 요청은 0으로 기록될 수 있습니다. 쿨다운 시각은 **재시도 예정** 시각입니다.

## 도구와 영상

AI Studio 작업자는 프로젝트 폴더 범위에서 파일 읽기·목록 조회·파일 작성·정확한 문자열 편집·명령 실행 도구를 사용합니다. 파일 변경과 명령 실행은 ChatterBox의 승인 및 범위 정책을 거칩니다. 읽기 전용 요청에서는 변경 도구를 실행하지 않습니다.

영상은 기본적으로 꺼져 있습니다. 설정에서 **영상 생성 사용**을 명시적으로 켠 뒤 사용자가 영상을 요청한 경우에만 영상 도구를 노출합니다. 이 변경에서 영상 로그인·생성·저장 흐름은 실행 검증하지 않았습니다.

## Antigravity 모델 가져오기

AI Studio 설정 화면의 **Antigravity 설정 내보내기**는 다음과 같은 Custom Model Enabler 가져오기 구조를 만듭니다. `externalModelName`은 AIStudio2API의 실제 `/v1/models` ID와 같아야 합니다.

```json
{
  "models": [
    {
      "name": "models/chatterbox-aistudio-argon",
      "displayName": "AI Studio · Argon",
      "provider": "custom",
      "externalModelName": "gemini-4-argon",
      "apiUrl": "http://127.0.0.1:2048/v1",
      "apiKey": "",
      "apiFormat": "openai",
      "enabled": true
    }
  ]
}
```

내보내기는 비밀값을 JSON에 넣지 않습니다. 해당 클라이언트가 로컬 API 키를 요구하면 `.env`의 키를 대상 프로그램에 직접 입력하고 파일이나 대화에 공개하지 않습니다. 이 설정은 Custom Model Enabler의 모델 가져오기용이며 `agy` CLI가 이 패치를 지원한다는 의미가 아닙니다.

## 데스크톱과 IDE

`antigravity-add-model`은 standalone Electron 데스크톱과 VS Code 기반 IDE에 서로 다른 절차를 사용합니다. 앱을 닫은 뒤 실행합니다.

Standalone 데스크톱:

```powershell
npm run patch:check -- --resources "C:\path\to\Antigravity\resources"
npm run doctor:repair -- --resources "C:\path\to\Antigravity\resources"
npm run patch:restore -- --resources "C:\path\to\Antigravity\resources"
```

`patch:check`는 검사만 하며, `doctor:repair`가 적용, `patch:restore`가 관리된 백업 복원입니다. 적용과 복원 전 데스크톱을 종료하고 끝난 뒤 직접 다시 엽니다.

IDE:

```powershell
npm run ide:check -- --resources "C:\path\to\Antigravity IDE\resources"
npm run ide:apply -- --resources "C:\path\to\Antigravity IDE\resources"
npm run ide:restore -- --resources "C:\path\to\Antigravity IDE\resources"
```

IDE 절차는 확인된 `jetski.cloudCodeUrl` 설정과 독립 로컬 프록시를 관리합니다. standalone 배포 스크립트로 IDE를 패치하거나, `agy` CLI가 데스크톱/IDE 패치를 소비한다고 가정하지 않습니다.

## 검증 범위

- [확인] 별도 준비 절차에서 공식 `v0.2.13` Windows runtime을 내려받고 릴리스 digest를 일치 확인.
- [확인] 별도 준비한 runtime의 manager local API 응답.
- [확인] 0.4.17 unit test 304개 통과. 서비스/driver 및 사용량 응답·기간 검증, 모델 전환·기록 삭제·범위 잠금 회귀 검사 포함.
- [확인] 기존 Gemini Web UI 25개와 provider UI 22개 통과.
- [확인] 새 공유 계정 UI 9개 통과.
- [확인] 0.4.17 사용량 UI 10개 통과. 기간·집계 전환, 이전 요청의 늦은 응답 무시, 조회 실패와 기록 없음 구분 포함. 공유 계정 UI 9개도 재검증.
- [확인] 0.4.17에서 실행 중인 서비스의 최근 24시간·7일·30일 통계와 실제 Electron 사용량 화면 조회. 확인 당시 13요청·46,713토큰. 이 사용량 검증은 기존 기록만 읽으며 모델·영상 생성 요청 0회.
- [확인] 이 저장소에서 설치 스크립트의 PowerShell 구문 파서 검사.
- [확인] 설치 스크립트를 별도 임시 경로에서 실행해 최신 release 다운로드·digest 검증·압축 해제·`.env` 생성 확인.
- [확인] 2026-10-20 사용자가 AI Studio 동의를 완료한 Gemini Web 계정 1개를 동기화하고 서비스 `RUNNING`, `gemini-4-argon` 사용 가능 상태 확인.
- [확인] 실제 Argon 대화와 다음 턴의 이전 답변 기억 확인.
- [확인] 실제 `read_file` 2회, `edit_file`, `run_command` 호출로 임시 프로젝트의 덧셈 버그를 수정. `node --test sum.test.cjs`의 테스트 3개 통과 및 모델 실행과 별개로 재실행해 동일 결과 확인.
- [확인] `v0.4.16` Windows portable 패키지 생성 및 빌드 출력 160개와 패키지 내용 일치 확인.
- [미검증] 10개 계정 동시 실연결, 실제 한도 소진·계정 전환·쿨다운 복구, native Antigravity IDE/client 요청. 계정 제한·연결·전환 관련 자동 검사는 모의 응답으로 수행.
- [미검증] 패키지 실행 UI. UI 검사는 빌드된 소스를 Electron으로 실행해 수행.
- [미실행] 영상 요청. 이번 검증에서 영상을 요청하지 않았으며 기본값은 영상 비활성입니다.

현재 외부 관리 프로그램인 AIStudio2API에 의존합니다. 릴리스·모델 목록·계정 자격·실제 쿨다운은 실행 시점과 Google 측 상태에 따라 달라질 수 있습니다.
