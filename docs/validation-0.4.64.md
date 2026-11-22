# v0.4.64 검증 기록

2026-11-22, Windows x64. 원격 저장소의 v0.4.63(`aa69d41`)에 로컬 원격 웹·로그인 확인·Antigravity UTF-8 변경을 통합했습니다.

| 검사 | 결과 |
| --- | --- |
| TypeScript main / renderer | 모두 통과 |
| `node scripts/test-unit.mjs` | 772개 통과 |
| `node scripts/e2e-settings-workers.mjs` | 31개 통과 |
| `node scripts/e2e-chat-list.mjs` | 14개 통과 |
| `node scripts/e2e-remote-web.mjs` | 67개 통과 |
| `node scripts/e2e-remote-ui-screens.mjs` | 86개 통과 |
| Electron Vite 빌드 | 통과 |
| NSIS 패키지 | 컴파일 파일 255개와 번들 사용량 모니터 4개를 빌드 결과와 대조 |
| 로컬 설치 | 종료 코드 0, 설치된 EXE·ASAR·모니터 해시 일치, 버전 0.4.64 |

원격 웹 검사는 PC·휴대폰 화면, 인증·권한 확인, 실시간 기록과 채팅 전환, 삭제 대상 변경, 프로젝트 설정, 업로드와 사용량 표시를 포함합니다. 최초 기록이 도착하기 전에 검사하던 고정 800ms 대기는 실제 계획 패널의 로딩 완료를 기다리도록 수정했습니다.

UI 검사는 별도 테스트 데이터와 합성 대화를 사용합니다. 실제 공급자에게 작업을 맡기거나 실제 로그인·생성 결과를 검증한 것은 아닙니다. 포함된 사용량 모니터는 `build/usage-monitor.json`의 고정 커밋 `fb9488bee265577560ed5681a40f9f5b8571f390`에서 빌드했습니다.

앱이 종료된 상태에서 대화 DB와 설정을 별도로 보관한 뒤 설치했으며, 설치 전후 DB·설정 해시가 같습니다. 설치 후 실제 사용자 데이터로 앱을 실행하지는 않았습니다.
