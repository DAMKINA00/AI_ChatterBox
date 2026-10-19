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
- [확인] unit test 302개 통과. 이 중 mocked service/driver 테스트 21개와 모델 전환·기록 삭제·범위 잠금 회귀 검사 포함.
- [확인] 기존 Gemini Web UI 25개와 provider UI 22개 통과.
- [확인] 새 공유 계정 UI 9개 통과.
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
