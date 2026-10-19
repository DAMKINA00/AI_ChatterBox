# 제3자 구성요소: AIStudio2API

ChatterBox의 AI Studio · Argon 경로는 로컬에서 실행되는 **Mag1cFall/AIStudio2API**의 OpenAI 호환 API를 사용합니다. ChatterBox는 이 프로젝트의 라이브러리 코드를 복사하지 않고 로컬 HTTP API를 호출합니다.

## 출처와 라이선스

- 프로젝트: [Mag1cFall/AIStudio2API](https://github.com/Mag1cFall/AIStudio2API)
- 문서화 기준 upstream revision: [`a784c51`](https://github.com/Mag1cFall/AIStudio2API/commit/a784c51)
- upstream 라이선스: [MIT license](https://github.com/Mag1cFall/AIStudio2API/blob/a784c51/LICENSE)
- Windows 배포물: 실행 시 [공식 최신 릴리스 API](https://api.github.com/repos/Mag1cFall/AIStudio2API/releases/latest)의 `windows-amd64.zip`을 조회합니다.
- Custom Model Enabler addon checkout: [`antigravity-add-model@21d6fe115ee3975e25f03cf7978feddb76a8e44d`](https://github.com/vahapogut/antigravity-add-model/commit/21d6fe115ee3975e25f03cf7978feddb76a8e44d), [Apache License 2.0](https://github.com/vahapogut/antigravity-add-model/blob/21d6fe115ee3975e25f03cf7978feddb76a8e44d/LICENSE). 이 문서는 해당 addon의 JSON 형식과 명령 경계를 참조할 뿐 addon 라이브러리 코드를 복사하지 않습니다.

AIStudio2API 자체의 upstream 소스와 릴리스는 별도의 제3자 구성요소입니다. 이 저장소의 설치 스크립트는 배포물을 내려받아 별도 버전 디렉터리에 보관하며, 같은 디렉터리를 덮어쓰지 않습니다. `.env`가 없는 새 디렉터리에만 로컬 API 키를 생성합니다. 키는 콘솔에 출력하거나 문서에 저장하지 않습니다.

## 사용 경계

AIStudio2API가 Google AI Studio 계정 세션, 모델 목록, 채널별 쿨다운, Worker 라우팅을 소유합니다. ChatterBox는 기존 Gemini Web 로그인에서 사용자가 선택한 같은 Google 계정을 명시적으로 연결하고, 선택한 Web 세션 상태를 로컬 AIStudio2API 동기화 경로로 전달합니다. ChatterBox 자체 저장소에는 원시 쿠키를 보관하지 않습니다. 로그인·동의·보안 확인은 사용자 브라우저에서 처리하며, ChatterBox가 Google 인증을 우회하거나 계정을 대신 로그인하지 않습니다.

기본 연결은 loopback `127.0.0.1:2048`, OpenAI Chat Completions 경로 `/v1/chat/completions`, 모델 목록 `/v1/models`입니다. 설치 기본값은 요청 본문 로그 끄기, 관리자 인증 끄기, 자동 생성 서비스 시작 끄기, `playground,build` 채널, 순수 Go WAA backend, 최대 Worker 10, 계정별 동시성 1, `fill-first`, warm Worker 2입니다. API 키가 필요한 클라이언트는 설치 디렉터리의 `.env` 값을 직접 입력해야 하며, 키를 이 저장소·채팅·로그에 복사하지 않습니다.

AIStudio2API 계정은 최대 10개로 제한하고, 웹 계정의 퍼센트 사용량과 AI Studio의 실제 쿨다운을 별도로 표시합니다. 퍼센트 한도를 AI Studio에 추정 적용하지 않습니다. 도구 실행은 ChatterBox의 프로젝트 범위와 승인 정책을 거치며, 영상 기능은 명시적으로 활성화하기 전까지 꺼져 있습니다.

## 검증 상태

검증 범위는 다음과 같습니다.

- [확인] 별도 준비 절차에서 공식 `v0.2.13` Windows runtime을 내려받고 릴리스 digest를 일치 확인.
- [확인] 별도 준비한 runtime의 manager local API 응답.
- [확인] unit test 302개 통과. 이 중 mocked service/driver 테스트 21개와 모델 전환·기록 삭제·범위 잠금 회귀 검사 포함.
- [확인] 기존 Gemini Web UI 25개와 provider UI 22개 통과.
- [확인] 새 공유 계정 UI 9개 통과.
- [확인] 설치 스크립트의 PowerShell parser syntax check.
- [확인] 설치 스크립트를 별도 임시 경로에서 실행해 최신 release 다운로드·digest 검증·압축 해제·`.env` 생성 확인.
- [대기] 첫 사용 AI Studio 동의가 필요한 실제 로그인.
- [미검증] 실제 Argon 생성·코딩, native IDE/client 요청, 실제 도구 호출과 쿨다운 복구.
- [미실행] 영상 요청. 이번 검증에서 영상을 요청하지 않았습니다.

따라서 실제 서비스 동작과 Google 측 계정·쿼터·모델 가용성은 설치 후 별도로 확인해야 합니다.
