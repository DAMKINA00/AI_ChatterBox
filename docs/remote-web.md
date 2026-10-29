# 원격 웹 접속 (https://ai.damkina.net)

휴대폰이나 다른 PC의 브라우저에서 ChatterBox 채팅을 보고, 추가 지시를 보내고, 승인 요청과 마스터 질문에 답할 수 있습니다.

## 구성

```
브라우저 ──HTTPS──▶ Caddy (이 PC, 80/443) ──HTTP──▶ 127.0.0.1:47821 (ChatterBox 화면 프로세스)
                                                        │ 기존 코어 RPC 채널 재사용
                                                        ▼
                                                  관리자 코어 (chats:list/events/send/stop/approve/answerAsk)
```

- 서버는 `src/main/remote-web.ts`에 있으며 화면(UI) 프로세스 안에서 실행됩니다. 기본값은 꺼짐이고, **127.0.0.1에만** 바인딩합니다. 외부 노출과 TLS는 Caddy가 맡습니다.
- 웹 페이지는 `src/renderer/remote.html`(+ `src/renderer/src/remote/`)로 빌드되어 `out/renderer/`에서 제공됩니다. 데스크톱과 같은 타임라인 로직(`timeline.ts`)을 쓰고, 실시간 갱신은 데스크톱 창이 받는 코어 이벤트를 그대로 SSE(`/api/stream`)로 전달합니다.
  - SSE 메시지마다 순번(SSE `id`)을 붙이고, 대화 스냅샷(`GET /api/chats/:id`)은 조회를 시작할 때의 순번(`seq`)을 함께 돌려줍니다.
  - 페이지는 스냅샷을 받는 동안 도착한 메시지를 버퍼에 모아 두고, 스냅샷을 적용한 뒤 순서대로 다시 적용합니다(`src/renderer/src/remote/stream.ts`).
    - 기록된 이벤트는 `seq`와 id로 이미 스냅샷에 있는 것을 걸러 냅니다. 그래서 스냅샷 조회 직후에 생긴 승인 요청도 빠지지 않습니다.
    - 작성 중 미리보기(text_delta)는 저장되지 않으므로 버퍼에 있는 것을 모두 다시 적용합니다. 그래서 작성 중인 답변의 앞부분이 사라지지 않습니다. 같은 답변의 최종 텍스트가 이미 스냅샷에 있으면 미리보기는 지웁니다. 다만 연결되기 전에 이미 흘러간 미리보기는 최종 텍스트가 도착할 때 보입니다(데스크톱 새로고침과 같음).
    - 채팅 상태(작업 중·승인 대기 등)도 순번으로 관리합니다. 목록·상세 스냅샷이 늦게 도착해도 더 새 `chat:updated`가 반영한 상태를 되돌리지 않습니다. 따라서 승인 대기 상태와 승인 버튼이 유지됩니다.
- 추가 지시는 데스크톱 입력창과 같은 `chats:send` 경로를 씁니다. 작업 중일 때는 **즉시 전달**(now)과 **다음 순서 예약**(next)을 고를 수 있고, 유휴 상태에서는 새 지시가 됩니다.
- 승인과 ask_user 답변도 앱과 같은 처리 경로를 씁니다. 앱과 웹에서 동시에 응답해도 먼저 도착한 응답 하나만 처리됩니다. 늦게 도착한 쪽은 웹에서 "이미 처리됐거나 만료된 요청"(409)으로 표시됩니다.
- 설정 파일은 `%APPDATA%\AI_ChatterBox\remote-web.json`입니다(활성화, 포트, 공개 주소, scrypt 비밀번호 해시, 로그인 방식, NAS 주소·인증서 지문·허용 계정). 세션은 메모리에만 있어서 앱을 다시 시작하면 모두 로그아웃됩니다.

## 로그인 방식 (`src/main/remote-auth.ts`)

인증은 공급자 교체형 구조입니다. 공급자는 자격 증명 확인만 맡고, 세션·로그인 잠금·CSRF는 공급자와 관계없이 `remote-web.ts`가 똑같이 적용합니다.

| 공급자 | 동작 |
|---|---|
| `local` | 앱에 저장한 scrypt 비밀번호. NAS 로그인을 쓸 때도 **비상용 로그인**으로 항상 유지됩니다(로그인 화면의 "비상용 로컬 비밀번호로 로그인"). |
| `synology-dsm` | 이 PC가 LAN에서 DSM Web API로 확인합니다. `SYNO.API.Info`로 로그인 API 경로를 조회한 뒤, `SYNO.API.Auth` login(version 6, `account`·`passwd`·`otp_code`, POST 본문)을 보냅니다. 성공하면 바로 `logout`합니다. NAS 비밀번호와 sid는 저장하거나 로그에 남기지 않습니다. |
| OIDC (Synology SSO Server 등) | 아직 구현하지 않았습니다. `AuthProvider` 인터페이스(`verify`)에 맞춰 공급자를 추가하면 됩니다. Authorization Code + PKCE처럼 리디렉션이 필요한 흐름은 콜백 경로를 함께 추가해야 합니다. |

NAS 로그인 보안 규칙:
- **허용 계정 목록이 필수**입니다. 비어 있으면 아무도 로그인할 수 없습니다. 목록에 없는 아이디는 NAS로 보내지 않습니다(다른 DSM 계정 탐색 방지). 대소문자는 구분하지 않습니다.
- NAS 주소는 `https://`만 허용합니다. DSM 기본 자체서명 인증서는 **SHA-256 지문 고정**으로 신뢰하며, 전역 TLS 검증은 끄지 않습니다. TLS 핸드셰이크에서 지문을 확인한 뒤에만 요청 바이트를 보내므로, 지문이 다르면 비밀번호는 전송되지 않습니다. 지문을 비우면 일반 CA 검증을 합니다.
- 브라우저에는 실패 이유와 관계없이 항상 같은 응답을 보냅니다: 401 "로그인 실패: 아이디·비밀번호·OTP를 확인하세요." 잘못된 아이디·비밀번호, OTP 필요·오류, 비활성 계정, 허용 목록 밖 아이디, NAS 연결 불가, NAS 보호 상한 도달이 모두 여기에 해당합니다.
- 응답 시간은 고정 구간(1.5초, 6초, 12초, 20초)까지 늘려서 보냅니다. NAS가 정상적으로 답하면 허용 목록 밖 아이디(NAS를 거치지 않음)와 목록 안 아이디가 모두 1.5초에 응답합니다. DSM 요청 제한 시간은 요청당 2.5초이며, 로그인 1회는 API 조회와 로그인 두 요청이라 최대 약 5초입니다. 이 경우 6초 구간에 들어갑니다.
- **남는 위험:** NAS가 느리거나 응답하지 않을 때는 목록 안 아이디만 6초 구간에 들어가서, 목록 밖 아이디(1.5초)와 응답 시간으로 구분될 수 있습니다. 대기열에서 기다린 시간도 응답 시간에 더해집니다. NAS를 정상 상태로 유지하세요. 앞단 보호(Caddy `basic_auth`, 현재 미사용)를 두면 이 차이를 외부에서 관찰하기 어렵습니다.
- 실제 원인은 앱의 원격 웹 접속 창 › **최근 로그인 실패**(최근 30건, 메모리)에만 보입니다. DSM 오류 코드도 여기에 표시됩니다: 400 잘못된 자격, 401 비활성 계정, 402 권한 없음, 403 OTP 필요, 404 OTP 오류, 406 2단계 인증 설정 필요, 407 IP 차단, 408~410 비밀번호 만료·변경 필요. 400~404는 로그인 실패 횟수(IP·계정 잠금)에 포함되고, NAS 연결 실패와 406·407·408~410은 포함하지 않습니다. NAS가 거부한 로그인은 오류 코드와 관계없이 아래 "NAS 보호 상한"에 집계됩니다.
- **NAS 보호 상한에 넣는 기준**(`DsmProvider.verify`, `dsmRequest`의 `sent` 표시):
  - **포함:** NAS가 로그인을 거부한 응답(`success:false`). 그리고 로그인 요청(`SYNO.API.Auth` login)을 보낸 뒤 결과를 알 수 없는 경우(타임아웃, 응답 유실·연결 끊김, 응답 해석 실패). NAS가 실패로 처리했을 수 있으므로 보수적으로 셉니다.
  - **제외:** 로그인 요청을 쓰기 전에 실패한 경우(TLS 지문 불일치, 연결 거부, `SYNO.API.Info` 단계 실패). NAS가 로그인 시도를 받지 않았으므로 DSM 실패 횟수가 늘 수 없습니다.
- 로그인 화면의 NAS 모드에는 OTP 입력란이 항상 보입니다.

## 로그인 제한: 가용성과 대입 공격 방어의 균형

전역 하드 잠금은 쓰지 않습니다. 이전 설계(전체 15분에 8회 실패하면 모두 잠금)에서는 무인증 공격자가 IP 두 개(5회 + 3회)만으로 모든 사용자의 로그인을 계속 막을 수 있었습니다.

| 단위 | 방식 | 이유 |
|---|---|---|
| 접속 IP | 15분 안에 5회 실패하면 그 IP만 15분 잠금 | 단일 출처의 대입 차단 |
| NAS 계정(아이디) | 15분 안에 8회 실패하면 그 계정만 15분 잠금 | 여러 IP로 한 계정을 노리는 공격 차단. 잠겨도 다른 계정과 비상용 로컬 비밀번호로는 들어올 수 있음. 기본 NAS 보호 상한(6)이 먼저 걸리므로 보조 장치 |
| NAS 보호 상한 | 모든 허용 계정 합계로 NAS가 거부했거나 보낸 뒤 결과를 모르는 로그인이 5분 안에 설정값(기본 6, 1~9)에 이르면, 5분이 지날 때까지 NAS를 호출하지 않고 통일 실패로 응답 | DSM 자동 차단(기본 5분 10회)은 출발지 IP 기준이고, 확인 요청은 모두 이 PC에서 나가므로 이 PC가 NAS에서 차단되는 것을 막기 위함. 비상용 로컬 로그인은 영향 없음 |
| 로컬 비밀번호 | 계정 잠금 없음(IP 잠금 + 전역 지연만) | 아이디가 없어 계정 잠금이 곧 전체 잠금이 되기 때문 |
| 전역 | 15분 안에 실패가 8회를 넘으면 요청마다 대기열에 들어가기 전에 1초씩 더 기다림(최대 10초). 잠그지 않으며 대기열 자리도 차지하지 않음 | 분산 공격 속도 완화. 정상 사용자는 느려질 뿐 막히지 않음 |
| 대기열 | NAS 확인: 동시 1개, 대기 8개. 로컬 비밀번호 확인: 동시 4개, 대기 32개. 서로 다른 대기열 | NAS가 막히거나 NAS 로그인이 몰려도 비상용 로컬 로그인은 별도 경로로 처리 |
| 대기 시간 제한 | NAS 15초, 로컬 10초가 지나면 대기열에서 빠지고 503. 브라우저 연결이 끊긴 요청도 바로 빠짐. 한 IP당 진행 중 로그인 1개 | 오래 기다리거나 버려진 요청이 자리를 차지하지 못하게 함 |

- **남는 위험:**
  - 여러 IP를 가진 공격자는 NAS 보호 상한을 반복해서 채워 NAS 로그인을 5분씩 멈추게 하거나, NAS 대기열을 채워 NAS 로그인에 503을 받게 할 수 있습니다. 이때도 비상용 로컬 로그인은 됩니다.
  - 로컬 대기열까지 채우려면 IP마다 동시 1개 제한과 IP별 잠금(15분에 5회)을 넘어야 하므로 많은 IP가 필요합니다.
  - 전역 지연은 요청마다 따로 걸리므로, 병렬로 보내는 분산 공격의 전체 시도 속도를 직접 묶지는 못합니다.
- **NAS 보호 상한 값 정하기:** DSM 자동 차단은 출발지 IP별로 셉니다. 같은 PC(192.168.0.144)에서 DSM에 접속하는 다른 로그인 시도도 같은 카운트에 더해집니다. 브라우저로 DSM에 직접 로그인할 때, Synology Drive·File Station·SMB 접속이 실패할 때 등이 해당합니다. 그래서 상한은 DSM 자동 차단 기준보다 **여유 있게 낮게** 두세요(기본 6은 DSM 기본 "5분 안에 10회" 기준). 이 PC에서 다른 DSM 로그인이 자주 실패한다면 더 낮추세요.
- **현재 운영 결정(2026-10-29):** 앞단 `basic_auth`는 **쓰지 않고**(사용자 결정), 앱 로그인(Synology NAS 계정 + 비상용 로컬 비밀번호)만으로 보호합니다. 그래서 다음 위험이 남습니다.
  - 인터넷 누구나 앱 로그인 화면과 `/api/login`에 바로 닿습니다. 무차별 시도는 IP·계정 잠금, NAS 보호 상한, 대기열 제한으로만 막습니다.
  - 여러 IP를 가진 공격자는 NAS 보호 상한(5분 6회)을 반복해서 채워 NAS 로그인을 일시적으로 막거나 늦출 수 있습니다. 이때 정상 사용자는 비상용 로컬 비밀번호로 들어와야 합니다.
  - NAS 계정 비밀번호가 유출되면 앱 전체(관리자 권한 명령 실행 포함)가 노출됩니다. 허용 NAS 계정에는 **2단계 인증(OTP)을 꼭 켜세요.** 비상용 로컬 비밀번호도 길고 고유하게 둡니다.
  - 위험을 더 줄이려면 아래 1번(`basic_auth` 또는 IP 제한)을 다시 켭니다.
- **공개 권장 조건:**
  1. (선택, 현재 미사용) 앞단 보호: Caddy `basic_auth`(예시 파일의 주석) 또는 접속 IP·국가 제한을 둡니다. 분산 로그인 시도와 로컬·NAS 대기열 포화를 앱까지 오기 전에 걸러 줍니다.
  2. 사이트 블록의 `header_up X-ChatterBox-Client-IP {client_ip}` 줄을 유지합니다. 없으면 접속자 IP를 위조해 IP별 잠금을 피할 수 있습니다.
  3. Caddy 앞에 다른 프록시가 있다면 `trusted_proxies`를 설정하고, 앱의 최근 로그인 실패에 실제 접속자 IP가 찍히는지 확인합니다.
  4. NAS 로그인을 쓰는 경우 위 기준에 따라 NAS 보호 상한을 DSM 자동 차단 설정보다 낮게 둡니다.

## 인증 세대(경쟁 조건 방지)
- 비밀번호 변경, 로그인 방식·NAS 설정·허용 계정 변경, 공개 주소 변경, 전체 로그아웃, 원격 접속 끄기는 모두 인증 세대 번호를 올립니다.
- 로그인 요청은 **도착한 순간**의 세대를 기억합니다. 대기열에서 확인을 시작할 때와 세션을 만들기 직전에 이 값을 다시 비교해서, 다르면 세션을 발급하지 않습니다(401, 쿠키 없음).
- 그래서 대기열에서 기다리던 요청이나 NAS 응답을 기다리던 요청도, 그 사이 전체 로그아웃이나 허용 계정 변경이 일어나면 세션을 얻지 못합니다. 대기 중이던 요청은 NAS에 보내지도 않습니다.

## 접속자 IP와 프록시 전제
- 접속자 IP는 Caddy가 넣는 `X-ChatterBox-Client-IP` 헤더에서만 읽습니다. 사이트 블록의 `header_up X-ChatterBox-Client-IP {client_ip}`가 이 값을 넣으며, 이는 Caddy가 확인한 클라이언트 IP입니다. `header_up`은 브라우저가 같은 이름으로 보낸 값을 덮어씁니다. 위조한 `X-ChatterBox-Client-IP: 6.6.6.6`이 실제 IP로 바뀌는 것을 임시 Caddy 2.11.4 인스턴스로 확인했습니다.
- 이 헤더는 원격 웹 접속 창의 "이 PC의 Caddy를 거쳐 접속함"(기본 켜짐)이 켜져 있고, 연결한 쪽(소켓 피어)이 127.0.0.1/::1이며, 값이 올바른 IP일 때만 씁니다. 그 밖에는 소켓 주소를 씁니다. `X-Forwarded-For`는 어떤 경우에도 쓰지 않습니다.
- 전제: `{client_ip}`가 실제 접속자여야 합니다. Caddy가 인터넷 접속을 직접 받으면 그대로 맞습니다. 앞에 다른 프록시가 있으면 그 프록시의 주소만 `trusted_proxies`로 신뢰해야 합니다. 현재 운영 구성(NAS Caddy가 앞단)은 아래 "NAS Caddy가 앞단인 구성"을 보세요.
- 사이트 블록에 `header_up` 줄이 없으면 외부에서 보낸 헤더 값이 그대로 전달될 수 있습니다. 그런 구성이면 이 설정을 끄세요. 끄면 모든 원격 접속이 127.0.0.1 하나로 집계되어, IP별 잠금이 전체 잠금처럼 동작합니다.
- 이 PC의 로컬 프로세스는 이 값을 위조할 수 있습니다(로컬 프로세스는 이미 신뢰 범위로 봅니다).

## NAS Caddy가 앞단인 구성 (현재 운영)

2026-10-29 확인 결과, 공유기는 공인 80/443을 이 PC가 아니라 **NAS(192.168.0.250)의 Caddy(내부 8080/8443)**로 넘깁니다.

```
브라우저 ─HTTPS─▶ 공유기 ─▶ NAS Caddy :8443 (공인 인증서, relight·filter·git 등)
                              └─HTTPS(SNI=호스트명)─▶ 이 PC Caddy :443 ─▶ 127.0.0.1:47821 (앱)
```

- 근거: 공인 IP로 접속하면 NAS:8443과 같은 인증서·본문을 받고, 포트 80은 301로 응답합니다(이 PC Caddy는 308). NAS에서 이 PC 443으로 HTTPS 연결이 열려 있는 것도 확인했습니다.
- 이 구성에서는 Let's Encrypt 확인 요청이 NAS로 가므로, **공인 인증서는 NAS Caddy가 발급**해야 합니다. 이 PC Caddy만 설정하면 발급이 계속 실패합니다(인증 확인 요청이 HTTPS로 넘겨지거나 `tls: internal error`).
- **이 PC Caddy** (`docs/remote-web.Caddyfile` 상단 블록)
  - `ai.damkina.net` 블록에 `tls internal`을 넣어 이 PC의 Let's Encrypt 재시도를 멈춥니다. NAS→이 PC 구간은 Caddy 내부 CA 인증서로 TLS 처리합니다(짧은 유효기간, Caddy가 자동 갱신).
  - 전역 `servers { trusted_proxies static 192.168.0.250/32 }`: NAS에서 온 요청만 `X-Forwarded-For`를 믿어 `{client_ip}`를 실제 접속자로 만듭니다. 다른 출처(127.0.0.1, 다른 LAN 기기)가 보낸 `X-Forwarded-For`와 위조한 `X-ChatterBox-Client-IP`는 무시되거나 덮어쓰입니다(임시 Caddy로 확인).
  - 기존 사이트 영향: relight 게이트웨이는 loopback에서 온 `CF-Connecting-IP`만 쓰고 `X-Forwarded-*`는 쓰지 않습니다(`gateway.py`의 `trusted_client_ip`). 접근 로그는 설정돼 있지 않습니다. 적용 전후 응답이 같음을 확인했습니다.
  - `basic_auth`를 쓴다면 이 PC 블록에 둡니다(NAS에는 두지 않음, 중복 인증 방지). 현재는 쓰지 않습니다.
- **NAS Caddy** (`docs/remote-web.Caddyfile` 하단 주석 블록)
  - relight와 같은 방식으로 `reverse_proxy https://192.168.0.144:443`에 `tls_server_name ai.damkina.net`을 둡니다. 이 PC 내부 CA 루트(`D:\Photo\ComfyUI\web_gateway\public\caddy-state\data\caddy\pki\authorities\local\root.crt`, 공개 인증서, 2036년 만료)를 NAS로 복사해 `tls_trust_pool file`(Caddy 2.8 미만은 `tls_trusted_ca_certs`)로 신뢰합니다. 전체 TLS 검증을 끄는 `tls_insecure_skip_verify`는 쓰지 않습니다.
  - `flush_interval -1`로 SSE를 바로 전달합니다.
  - NAS에는 `trusted_proxies`를 두지 마세요. 그래야 NAS가 받은 `X-Forwarded-For`를 실제 접속자 IP로 덮어씁니다.
  - 이 블록을 이 PC에서 NAS 역할로 띄운 임시 Caddy로 확인했습니다. 인증 없이 401, basic_auth로 `/` 200, `/api/auth-info` 200이었습니다.

### NAS 실제 적용 (2026-10-29)
- **NAS Caddy:**
  - 컨테이너 `caddy-gateway`(이미지 `caddy:2-alpine`, Caddy v2.11.4), compose `/volume1/docker/caddy-gateway/compose.yaml`.
  - 포트는 `192.168.0.250:8080→80`, `8443→443`입니다. 공유기가 공인 80/443을 여기로 넘깁니다.
  - 마운트는 `./Caddyfile → /etc/caddy/Caddyfile`(읽기 전용 **단일 파일** 마운트), `./data → /data`, `./config → /config`입니다.
- **기존 블록 형식:** relight·clapper·animated·filter·play.origaminis.com은 `reverse_proxy https://192.168.0.144:443 { header_up Host <호스트>; transport http { tls_server_name <호스트> } }`(일반 CA 검증)입니다. 해당 호스트의 HTTP-01 인증 요청은 `http://…` 블록이 이 PC의 80으로 넘깁니다. git·play.damkina.net·fm.damkina.net은 NAS 안의 컨테이너가 처리합니다.
- **추가한 블록:** 같은 형식에 `tls_trust_pool file /data/chatterbox-pc-root.crt`와 `flush_interval -1`을 더했습니다(`docs/remote-web.Caddyfile` 하단과 같음). 이 PC의 루트 인증서는 `/volume1/docker/caddy-gateway/data/chatterbox-pc-root.crt`(root:root 0644)로 복사했습니다.
- **적용 방법:** 단일 파일 마운트라서 파일을 바꿔치기하면(새 inode) 컨테이너가 이전 내용을 계속 봅니다. 그래서 **같은 inode에 이어 붙였습니다**(`cat 블록 >> Caddyfile`, inode 1038 유지).
  - 먼저 후보 파일을 `/data`에 두고 `docker exec caddy-gateway caddy validate`를 통과시킨 뒤 반영했고, `docker exec caddy-gateway caddy reload`로 불러왔습니다. 컨테이너는 재시작하지 않았습니다.
  - "not formatted" 경고는 기존 4칸 들여쓰기에서 나오는 것으로, 동작과는 관계없습니다.
- **백업:** `/volume1/docker/caddy-gateway/Caddyfile.bak-20261029-ai`(블록 추가 전, 권한 유지).
- **결과:**
  - Let's Encrypt 인증서가 reload 직후 발급됐습니다(YE1, 2027-01-27 만료).
  - 공인 IP 경유로 basic_auth 적용 당시에는 인증 없이 401, 자격 입력 시 `/` 200, `/api/auth-info` 200이었습니다.
  - 같은 날 사용자 결정으로 basic_auth를 제거한 뒤에는 `/` 200(앱 로그인 화면), `/api/auth-info` 200, `/api/chats` 401(앱 로그인 필요)입니다. 제거 전 백업은 `Caddyfile.bak-20261029-2342-nobasicauth`입니다.
  - 기존 사이트 8개(relight·clapper·animated·filter·play.origaminis.com·git·play.damkina.net·fm)의 공인 응답은 적용 전과 같습니다. git 본문은 요청마다 CSP nonce가 바뀌므로 상태·형식으로 비교했습니다.
- **접속자 IP:** NAS의 Docker는 외부 트래픽을 iptables DNAT로 컨테이너에 넘기므로 출발지 IP가 유지됩니다. NAS Caddy는 이를 `X-Forwarded-For`로 이 PC에 전달하고, 이 PC Caddy는 `trusted_proxies`로 받아 `X-ChatterBox-Client-IP`에 넣습니다. 외부(LTE) 접속 시 앱의 세션·최근 로그인 실패에 실제 공인 IP가 찍히는지 확인하세요. LAN에서 공인 IP로 되돌아오는 접속은 공유기 주소로 보일 수 있습니다.
- **되돌리기:** NAS에서 백업을 같은 inode로 덮어씁니다(`cat Caddyfile.bak-20261029-ai > Caddyfile`). 그다음 `docker exec caddy-gateway caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`를 실행합니다.

## 보안 설계

| 항목 | 동작 |
|---|---|
| 노출 범위 | 127.0.0.1 바인딩, 기본 꺼짐. 비밀번호가 없으면 켤 수 없음 |
| 비밀번호 | 12자 이상. scrypt(N=2^15, r=8) 해시만 저장하고 평문은 저장하지 않음. 바꾸면 전체 세션 로그아웃 |
| 세션 | 32바이트 난수 쿠키 `__Host-cbx_session`(HttpOnly·Secure·SameSite=Strict·Path=/). 서버는 SHA-256 값만 보관. 12시간 미사용 또는 7일 경과 시 만료. 로그아웃·전체 로그아웃·개별 해제 지원 |
| 로그인 제한 | 공급자와 관계없이 적용. IP별 잠금, NAS 계정별 잠금, NAS 보호 상한, 전역 점증 지연(하드 잠금 없음), NAS·로컬 대기열 분리. 자세한 내용은 위 "로그인 제한" 절 참고. 잠금 응답은 429와 Retry-After |
| 로그인 응답 | 실패는 항상 같은 401 문구, 응답 시간은 고정 구간(1.5/6/12/20초)까지 늘림. 실제 원인은 앱 화면에만 표시 |
| 경쟁 조건 | 인증 세대 번호를 요청 도착 시점에 기억. 대기·확인 중에 설정이 바뀌거나 전체 로그아웃되면 세션을 발급하지 않음 |
| CSRF | 모든 POST에 세션별 `X-CSRF-Token` 필요. `Origin`이 공개 주소(또는 127.0.0.1/localhost:포트)와 같아야 함. `Sec-Fetch-Site`는 same-origin만 허용. `Content-Type: application/json`만 허용 |
| DNS rebinding | `Host` 헤더가 공개 주소 호스트나 127.0.0.1/localhost:포트가 아니면 421 |
| 인증 없는 경로 | `POST /api/login`, 로그인 화면용 `GET /api/auth-info`(설정된 로그인 방식 이름만 응답), 정적 페이지(`/`, `/assets/*`)뿐. 정적 파일에는 사용자 데이터가 없음 |
| XSS | Markdown은 react-markdown으로 렌더링하며 raw HTML은 렌더링하지 않음. 링크는 기본 URL 필터를 거치고 `noopener noreferrer`로 엶. 외부 이미지는 불러오지 않음. CSP는 `default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'` 등 |
| 노출 정보 | 프로젝트는 id·이름만 보냄(폴더 경로·설정 제외). 첨부 파일 내용과 이미지 원본은 제공하지 않음 |

> 원격 지시와 승인은 이 PC에서 관리자 권한 코어가 명령을 실행하게 할 수 있습니다. 긴 비밀번호를 쓰고, 허용 NAS 계정에는 OTP를 켜세요. 앞단 Caddy `basic_auth`는 선택 사항이며 현재는 쓰지 않습니다(위 "현재 운영 결정" 참고).

## 적용 절차

### 1. 앱 설정
1. 새 버전을 설치하고 실행합니다.
2. 사이드바 사용량 영역의 ⚙(연결 설정) 메뉴에서 **원격 웹 접속**을 엽니다.
3. 비밀번호(12자 이상)를 저장합니다.
4. 내부 포트(기본 47821)와 공개 접속 주소(`https://ai.damkina.net`)를 확인하고 스위치를 켭니다. 상태가 "실행 중"이 되어야 합니다.
5. 이 PC에서 확인: `Invoke-WebRequest http://127.0.0.1:47821/ -UseBasicParsing` 결과가 200이면 됩니다(브라우저 로그인은 공개 주소에서 합니다).

### 1-1. NAS 계정 로그인 (선택, Synology DSM `192.168.0.250`)
NAS 쪽:
1. 원격 로그인에 쓸 DSM 계정을 정합니다. 관리자 계정을 쓴다면 **2단계 인증(OTP)을 켜 두는 것을 권장**합니다: DSM › 개인 › 보안 › 2단계 인증.
2. 관리자가 아닌 계정을 쓰면 DSM › 제어판 › 응용 프로그램 권한 › **DSM** 접근을 허용해야 합니다. 허용하지 않으면 DSM 오류 402 "로그인 권한 없음"이 납니다.
3. DSM › 제어판 › 보안 › 계정 › **자동 차단**은 켜 둔 채로 두면 됩니다. 원격 로그인 확인은 모두 이 PC IP(현재 192.168.0.144)에서 나가므로, 차단되면(앱의 최근 로그인 실패에 DSM 오류 407로 표시) 자동 차단 목록에서 이 PC IP를 해제하세요. 앱의 **NAS 보호 상한**(모든 허용 계정 합계 5분에 6회, 앱에서 1~9로 변경 가능)은 DSM 자동 차단 설정값보다 낮아야 합니다. DSM 설정을 바꿨다면 이 값도 맞춰 주세요.
4. NAS를 외부에 공개하지 않아도 됩니다. ChatterBox가 LAN에서 5001 포트로만 접속합니다.

앱 쪽(원격 웹 접속 창 › 로그인 방식):
1. **Synology NAS(DSM) 계정**을 고르고 NAS 주소 `https://192.168.0.250:5001`을 확인합니다.
2. **인증서 확인**을 눌러 SHA-256 지문을 봅니다. DSM › 제어판 › 보안 › 인증서에서 해당 인증서의 지문과 같은지 확인한 뒤 **이 지문 고정**을 누릅니다. 2026-10-29 조회값은 `C8:7E:81:72:95:98:76:F2:84:7D:32:19:8A:8F:A5:B6:85:41:39:42:02:5B:73:7B:71:E5:6C:12:F4:39:A1:3A`입니다(DSM 기본 "synology" 인증서, 2027-05-23 만료).
3. 허용 NAS 계정(줄마다 하나)을 입력하고 **로그인 방식 저장**을 누릅니다. 저장하면 모든 원격 세션이 로그아웃됩니다.
4. 비상용 로컬 비밀번호도 설정해 둡니다. NAS가 꺼졌거나 인증서가 바뀌었을 때 로그인 화면 아래 링크로 들어올 수 있습니다.
5. DSM 인증서를 갱신하거나 교체하면 지문이 바뀝니다. 그때는 2번을 다시 하세요(지문이 다르면 로그인을 거부하고 비밀번호도 보내지 않습니다).

### 2. DNS (Squarespace Domains, `damkina.net`의 NS는 `nsb1~4.squarespacedns.com`)
기존 `relight`·`filter`·`git` 서브도메인과 같은 방식으로 레코드를 추가합니다.

| 호스트 | 유형 | 값 |
|---|---|---|
| `ai` | CNAME | `damkina.iptime.org` |

확인: `Resolve-DnsName ai.damkina.net` 결과가 `damkina.iptime.org`를 거쳐 공인 IP로 나와야 합니다.

### 3. Caddy (운영 중: `D:\Photo\ComfyUI\tools\caddy.exe`, 설정 `D:\Photo\ComfyUI\web_gateway\public\Caddyfile`)
이 Caddy는 relight/clapper/animated/filter 사이트와 함께 쓰므로, 반드시 백업한 뒤 검증하고 다시 불러옵니다.

```powershell
$dir = "D:\Photo\ComfyUI\web_gateway\public"
$caddy = "D:\Photo\ComfyUI\tools\caddy.exe"
# 운영과 같은 저장소를 쓰도록 run_caddy.bat과 같은 환경 변수를 둡니다.
$env:XDG_DATA_HOME = "$dir\caddy-state\data"; $env:XDG_CONFIG_HOME = "$dir\caddy-state\config"
Copy-Item "$dir\Caddyfile" "$dir\Caddyfile.bak-$(Get-Date -Format yyyyMMdd-HHmm)-remoteweb"
# docs\remote-web.Caddyfile의 "이 PC" 부분(전역 trusted_proxies 병합 + ai.damkina.net 블록)을 반영한 뒤:
& $caddy validate --config "$dir\Caddyfile" --adapter caddyfile
& $caddy reload   --config "$dir\Caddyfile" --adapter caddyfile
```

- 블록의 `header_up X-ChatterBox-Client-IP {client_ip}` 줄은 지우지 마세요. IP별 잠금이 이 값에 의존합니다(위 "접속자 IP와 프록시 전제").
- **basic_auth(선택, 현재 미사용):**
  - 2026-10-29에 적용했다가 같은 날 사용자 결정으로 제거했습니다. 사용하던 비밀번호 파일도 삭제했습니다.
  - 제거 이유: 휴대폰 브라우저 인증창에서 입력이 어려웠습니다(대소문자·혼동 문자가 섞인 32자). 서버 쪽 자격은 정상이었습니다.
  - 다시 켜려면 사용자명 `chatterbox`와 휴대폰 입력이 쉬운 무작위 비밀번호(혼동 문자 0/O/1/l/I 제외, 소문자·숫자 24자 이상)를 씁니다. 해시는 `& $caddy hash-password`에 표준 입력으로 넣어 만들고, 원문은 `%APPDATA%\AI_ChatterBox\remote-web-basicauth.txt`에만 둡니다.
- `reload`는 관리 API(localhost:2019)를 사용합니다. 현재 Caddyfile에는 `admin off`가 없으므로 그대로 동작합니다. 파일 내용이 그대로인데 인증서 재시도를 바로 시작하려면 `reload --force`를 씁니다.
- 공인 인증서는 **NAS Caddy가** 발급합니다(위 "NAS Caddy가 앞단인 구성"). NAS에 블록을 추가하고 NAS Caddy를 다시 불러오면 DNS가 반영된 상태에서 자동으로 발급됩니다.

### 4. 확인
```powershell
Resolve-DnsName ai.damkina.net
curl.exe -sI https://ai.damkina.net/            # 200(앱 로그인 화면), 유효한 공인 인증서 (basic_auth를 켜면 401)
curl.exe -s  https://ai.damkina.net/api/auth-info  # {"provider":"synology-dsm"}
curl.exe -s  https://ai.damkina.net/api/chats      # 401(앱 로그인 필요)
```
휴대폰(LTE)에서 `https://ai.damkina.net`에 접속합니다. 앱 로그인 화면에서 NAS 아이디·비밀번호·OTP로 로그인하고, 채팅 목록 → 채팅 → 지시 전송까지 확인합니다. 앱의 원격 웹 접속 창에서 세션이 보이면 정상입니다.

### 되돌리기
- 앱: 원격 웹 접속 스위치를 끕니다. 서버가 즉시 닫히고 모든 세션이 끝납니다.
- Caddy: 백업한 Caddyfile을 복원한 뒤 `reload`합니다. 운영 백업은 `Caddyfile.bak-20261029-remoteweb`(블록 추가 전)과 `Caddyfile.bak-20261029-2304-nasproxy`(tls internal·trusted_proxies 적용 전)입니다. NAS Caddy의 블록은 `/volume1/docker/caddy-gateway/Caddyfile.bak-20261029-ai`로 되돌립니다(위 "NAS 실제 적용"의 되돌리기 참고).
- DNS: `ai` CNAME을 삭제합니다.

## 개발·검증
- 단위 테스트: `npm test`
  - `src/main/remote-web.test.ts`: 인증, IP 잠금(동시 요청 포함), 두 IP로 전체를 잠글 수 없음과 전역 지연, 통일 응답과 시간 구간, Caddy 헤더 기반 접속자 IP(XFF 무시), 대기열 시간 제한·연결 종료·상한, CSRF/Origin/Host, 무단 접근 차단, 지시·중지·승인·답변 전달, 중복 응답 409, 세션 만료·해제, SSE 필터·순번·스냅샷 seq
  - `src/main/remote-auth.test.ts`: mock DSM(HTTPS, 자체서명 인증서 `scripts/fixtures/dsm-test-cert.json`) 대상
    - 지문 확인, 지문 불일치·미고정 시 비밀번호 미전송, POST 본문 전송과 logout, 허용 목록, 오류 코드·OTP 상세 원인, NAS 연결 실패, 목록 안·밖 아이디의 동일 응답
    - NAS 계정 잠금과 비상용 로그인 유지, NAS 보호 상한(여러 계정 합계, NAS 미호출, 5분 뒤 복구)
    - NAS가 로그인 요청을 받고 응답하지 않아 타임아웃되면 상한에 포함됨, 지문 불일치·연결 실패는 제외됨
    - NAS 대기열이 가득 찼을 때 비상용 로컬 로그인 성공
    - 느린 NAS 요청 뒤에서 기다리던 요청이 전체 로그아웃 후 실패(NAS 미호출)
    - 지연된 DSM 응답 중 허용 계정 변경·전체 로그아웃·비밀번호 변경 시 세션 미발급
  - `src/renderer/src/remote/stream.test.ts`: 스냅샷 조회 뒤·응답 전에 생긴 승인 요청 보존, 중복 제거, 작성 중 답변 앞부분 보존과 완료된 미리보기 제거, 늦게 온 스냅샷이 승인 대기 상태를 되돌리지 않음과 승인 버튼 표시, 스냅샷 뒤 새 채팅 유지, 작업자·협의 갱신 순서 재생
- 실제 앱 + Edge e2e: `npm run build` 후 `node scripts/e2e-remote-web.mjs`. 임시 데이터 폴더를 쓰며, API 키가 없는 DeepSeek 마스터로 구성해 실제 AI 계정을 호출하지 않습니다. NAS 로그인은 mock DSM으로 확인합니다.
- 개발 모드(`npm run dev`)에서는 원격 페이지를 `out/renderer`에서 제공하므로, 먼저 `npm run build`를 한 번 실행해야 합니다.
