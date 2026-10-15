# 0.4.4 로그인 수정 검증

검증일: 2026-10-15. 기준: 0.4.3 `e3c3574`.

## 원인과 수정

기존 코드는 `window.open`을 거부하면서 요청 주소를 원래 창의 `loadURL`로 다시 열었습니다. 원래 페이지의 로딩을 중단하고 팝업과 원래 창의 연결·POST 전송을 유지하지 못하는 구조였습니다. 또한 Google의 `SetSID`·`CheckCookie` 중간 이동을 차단하고 있어, 인증이 저장된 뒤에도 Gemini 화면으로 돌아가는 흐름이 막힐 수 있었습니다. 제공된 화면만으로 실제 계정이 사용한 중간 주소를 확정하지는 않습니다.

- 같은 계정 세션의 격리된 로그인 팝업을 유지하고 원래 창과의 연결을 보존합니다. 팝업에도 Node 접근·앱 preload를 제공하지 않고 sandbox와 HTTPS 주소 검사를 적용합니다. [Electron 창 생성 문서](https://www.electronjs.org/docs/latest/api/window-open), [setWindowOpenHandler](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwindowopenhandlerhandler).
- Google의 `www.google.com`·`www.google.co.kr`·`accounts.youtube.com`에서 `/accounts/SetSID`·`/accounts/CheckCookie` 경로만 추가로 허용합니다. 다른 주소는 계속 차단하며 오류에는 호스트·경로만 표시합니다.
- 첫 페이지의 로딩이 허용된 로그인 이동으로 중단된 `ERR_ABORTED`이면 창과 로그인 확인을 유지합니다. 실제 접속 실패와 일반 중단은 오류로 처리합니다.
- 팝업에서 인증된 Gemini 입력창·모델을 확인하면 원래 Gemini 화면을 한 번 갱신합니다. 완료 안내를 표시하고 안전한 로그인 창을 닫습니다. Google 비밀번호·보안 확인 페이지에는 스크립트를 실행하지 않습니다.
- 원래 창이나 팝업에 초안·생성 중인 응답이 있으면 유지합니다. 로그인 팝업이 열려 있는 계정에는 작업을 배정하지 않습니다. 화면 복귀의 실제 연결 오류는 무한 대기 대신 오류로 알립니다.

## 검사

- Node/Web TypeScript 검사 및 Electron/Vite 빌드 통과.
- 단위 테스트 **216/216** 통과. 인증 이동 정책·정상 중단과 실제 오류 구분·비밀값 없는 오류 안내·팝업 초안·비동기 화면 복귀·작업 배정 차단·실패 피드백을 포함합니다.
- `scripts/smoke-gemini-web-auth.mjs`: **11/11**. 실제 Electron 창에서 첫 로딩 중 팝업 생성 → 원래 창 유지 → Google 형식의 다음 버튼 → 쿠키 인계 경유 → 팝업의 Gemini 연결 → 원래 창 갱신 → 완료 안내·창 닫힘을 확인합니다. 계정 세션·sandbox·외부 주소 차단·종료도 확인했습니다. 모든 HTTPS는 격리된 로컬 fixture이며 Google 서버에 접속하지 않습니다.
- 같은 첫 로그인 fixture를 수정 전 `e3c3574` 코드에 적용하면 `ERR_ABORTED (-3) loading 'https://gemini.google.com/signin?continue=fixture'`가 발생했습니다. 제공된 첫 오류와 같은 실패를 재현했고 수정 후 동일 시나리오가 통과했습니다. 수정 전 결과는 `.scratch/gemini-auth-native-1792027542402/results.json`에 보관했습니다.
- `scripts/smoke-gemini-web-login.mjs`: **13/13**. 기존 여러 계정 로그인·완료 알림 1회·수동 열기·초안·응답 생성·취소·작업자 소유·종료 검사를 통과했습니다.
- `scripts/e2e-gemini-web-ui.mjs`: **25/25**. 계정별 상태·알림·취소·사용량·모델 선택·다크/라이트 및 좁은 화면 검사를 통과했습니다.
- 최종 인증 fixture: `.scratch/gemini-auth-native-1792027469975/results.json`. 기존 로그인 fixture: `.scratch/gemini-login-native-1792027186565/results.json`. UI fixture: `.scratch/gemini-web-accounts-ui/1792027344287/`.

## 범위와 배포

실제 Google 계정의 비밀번호 입력·추가 보안 확인을 대신하거나 새로 수행하지 않았습니다. 계정별 Google 흐름은 새 실행 파일에서 사용자가 확인해야 합니다. 기존 로그인 프로필과 프로덕션 작업은 유지하며 앱을 자동 재시작하지 않습니다.

- `dist/AI_ChatterBox-0.4.4-portable.exe`: **164,585,454바이트**.
- SHA-256: `97576d827ad457564c656ea5e7c5755d9ca4dca528dbbd210101ff3dcc95f489`.
- 포터블과 내부 실행 파일의 PE manifest 모두 `requireAdministrator` 확인. 이번 수정에서 새 UAC 승인·취소는 재수행하지 않았습니다.
- 패키지 버전 `0.4.4` 확인 및 최신 빌드 파일 **148개 전체**의 내용 일치 확인.
- 최종 읽기 전용 상태 확인 당시 기존 앱에서 진행 중인 채팅이 1개 있어 재시작하지 않았습니다. 작업이 끝난 뒤 새 포터블을 실행해야 변경이 적용됩니다.
