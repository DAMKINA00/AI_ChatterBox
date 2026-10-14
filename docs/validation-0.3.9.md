# AI_ChatterBox 0.3.9 검증 기록

검증일: 2026-10-14. 진행 중인 사용자 앱과 작업은 유지했습니다.

## 변경

- 사람이 보낸 대화의 표시 이름은 `관리자`입니다. 기존 기록에도 같은 이름과 36px 캐릭터를 표시하며, 저장된 `user` 이벤트와 본문은 변경하지 않습니다.
- 관리자 캐릭터는 기존 마스터·GPT 기본 표정을 스타일 참조로 이미지 생성했습니다. 투명 PNG 원본을 그대로 보관하며 모델 캐릭터와 구분되는 짧은 남색 머리·보라 눈·회색 후드를 사용합니다. [제작 기록](admin-character-art.md)
- 기본 버튼과 `Enter`는 즉시 전달, 작업 중 보조 버튼과 `Alt+Enter`는 다음 단계 전달입니다. `Shift+Enter` 줄바꿈·IME 조합 중 전송 방지·첨부 전송을 유지합니다.
- 전달 방식이 생략된 IPC 호출도 즉시 전달로 처리합니다. 명시적인 `next`는 기존대로 대기열에 보관합니다.

## 검증

| 구분 | 결과 | 범위 |
|---|---|---|
| Node/Web 타입 검사 | 통과 | 두 tsconfig의 tsc --noEmit |
| 자동 회귀 검사 | 151/151 | 기본 즉시 전달과 명시적 다음 단계 대기열 분리 포함 |
| 캐릭터 파일 검사 | 49/49 | 모두 1254 × 1254, 투명·불투명 픽셀 존재, Electron nativeImage 디코딩 |
| 격리 입력창 UI | 15/15 | Enter·Alt+Enter·Shift+Enter·IME·두 버튼·첨부 ID·과거 관리자 아바타 |
| 격리 대화 UI | 13/13 | 다크·라이트 테마, 저장된 시각, 재실행, 좁은 창과 두 전송 버튼 |
| 프로덕션 빌드 | 통과 | electron-vite build |
| 포터블·실행 권한·무결성 | 통과 | 포터블·내부 EXE requireAdministrator, ASAR 148개 파일이 최종 out과 일치 |

이번 변경에서는 실제 모델 작업과 UAC 승인을 새로 실행하지 않았습니다. 입력창 동작은 격리 데이터와 IPC 기록으로 확인하며 실제 CLI에 추가 메시지를 전달하는 검증과 구분합니다. 기존 즉시 전달 엔진 검증은 [0.3.7 기록](validation-0.3.7.md)에 있습니다. 새 실행 파일은 진행 중인 작업 종료 후 적용합니다.

화면 증거: `.scratch/e2e-chat-composer/composer-busy.png`, `.scratch/e2e-chat-composer/composer-idle.png`, `.scratch/e2e-chat-layout/discord-dark.png`, `.scratch/e2e-chat-layout/discord-light.png`, `.scratch/e2e-chat-layout/discord-compact.png`. 관리자 아바타와 버튼 배치를 직접 확인했습니다. 이미지 파일은 [캐릭터 제작 기록](admin-character-art.md)에 연결했습니다.

Gemini 웹 채팅 자동 연동은 이 버전에 포함하지 않습니다.

산출물: `dist/AI_ChatterBox-0.3.9-portable.exe` (164,568,589 bytes).
SHA256: `CA5C06115744FF7B0801CF2A713484030B553685481ADF5D7A6737DB5BA2BF53`.
