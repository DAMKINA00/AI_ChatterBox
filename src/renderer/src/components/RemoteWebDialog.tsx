import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Globe, KeyRound, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { REMOTE_UPLOAD_STORAGE, REMOTE_WEB_MIN_PASSWORD, type RemoteAuthProvider, type RemoteWebAction, type RemoteWebInput, type RemoteWebStatus } from "../../../shared/remote-web";
import { api, errorMessage, timeAgo } from "../lib/utils";
import { Badge, Button, Dialog, DialogContent, DialogFooter, Input, Label, Switch } from "./ui";

type Run = (action: RemoteWebAction, input?: RemoteWebInput) => Promise<RemoteWebStatus | undefined>;

/** Login method: local password only, or Synology DSM accounts (local password stays as emergency login). */
function LoginMethod({ status, busy, run }: { status: RemoteWebStatus; busy: boolean; run: Run }) {
  const [provider, setProvider] = useState<RemoteAuthProvider>(status.provider);
  const [url, setUrl] = useState(status.dsm.url);
  const [pin, setPin] = useState(status.dsm.certSha256);
  const [users, setUsers] = useState(status.dsm.allowedUsers.join("\n"));
  const [limit, setLimit] = useState(String(status.dsmFailureLimit));
  const [probe, setProbe] = useState<RemoteWebStatus["dsmProbe"]>();
  // Reset the form only when the saved values change, not on every status refresh (a probe keeps typed edits).
  const saved = JSON.stringify([status.provider, status.dsm, status.dsmFailureLimit]);
  useEffect(() => {
    setProvider(status.provider); setUrl(status.dsm.url); setPin(status.dsm.certSha256); setUsers(status.dsm.allowedUsers.join("\n")); setLimit(String(status.dsmFailureLimit));
  }, [saved]);
  const allowedUsers = users.split(/[\s,]+/).map(u => u.trim()).filter(Boolean);
  const dirty = provider !== status.provider || url !== status.dsm.url || pin !== status.dsm.certSha256 || allowedUsers.join("\n") !== status.dsm.allowedUsers.join("\n") || Number(limit) !== status.dsmFailureLimit;
  const check = async () => setProbe((await run("dsm-probe", { dsmUrl: url }))?.dsmProbe);
  return (
    <div className="grid gap-3 rounded-lg border p-3" data-testid="remote-web-login-method">
      <div className="text-[12px] font-medium">로그인 방식</div>
      <div className="grid gap-1.5 text-[12.5px]" role="radiogroup" aria-label="로그인 방식">
        <label className="flex items-center gap-2"><input type="radio" name="remote-provider" checked={provider === "local"} onChange={() => setProvider("local")} /> 로컬 비밀번호</label>
        <label className="flex items-center gap-2"><input type="radio" name="remote-provider" checked={provider === "synology-dsm"} onChange={() => setProvider("synology-dsm")} /> Synology NAS(DSM) 계정 · 로컬 비밀번호는 비상용으로 유지</label>
      </div>
      {provider === "synology-dsm" && (
        <div className="grid gap-2.5">
          <div className="grid gap-1.5">
            <Label htmlFor="remote-dsm-url">NAS 주소 (LAN)</Label>
            <div className="flex gap-2">
              <Input id="remote-dsm-url" value={url} onChange={e => setUrl(e.target.value)} spellCheck={false} placeholder="https://192.168.0.250:5001" className="font-mono text-[12px]" />
              <Button type="button" size="sm" variant="outline" disabled={busy || !url} onClick={() => void check()}><ShieldCheck /> 인증서 확인</Button>
            </div>
          </div>
          {probe && (probe.error
            ? <div role="alert" className="text-[11.5px] text-destructive">{probe.error}</div>
            : <div className="grid gap-1.5 rounded-md bg-muted/50 p-2 text-[11.5px]">
                <div>NAS 인증서 SHA-256 지문 {probe.trusted ? <Badge className="border-success/40 text-success">신뢰됨</Badge> : <Badge className="border-warning/50 text-warning">고정 필요</Badge>} · 로그인 API {probe.authPath}</div>
                <div className="break-all font-mono">{probe.fingerprint}</div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">DSM 제어판 › 보안 › 인증서에서 같은 지문인지 확인한 뒤 고정하세요.</span>
                  <Button type="button" size="xs" variant="outline" disabled={pin === probe.fingerprint} onClick={() => setPin(probe.fingerprint)}>이 지문 고정</Button>
                </div>
              </div>)}
          <div className="grid gap-1.5">
            <Label htmlFor="remote-dsm-pin">고정한 인증서 지문 (자체 서명 인증서일 때 필수)</Label>
            <Input id="remote-dsm-pin" value={pin} onChange={e => setPin(e.target.value)} spellCheck={false} placeholder="비우면 일반 인증서 검증" className="font-mono text-[11.5px]" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="remote-dsm-users">허용 NAS 계정 (줄마다 하나, 비어 있으면 아무도 로그인할 수 없음)</Label>
            <textarea id="remote-dsm-users" rows={2} value={users} onChange={e => setUsers(e.target.value)} spellCheck={false}
              className="rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="remote-dsm-limit">NAS 실패 상한 (5분, 모든 허용 계정 합계)</Label>
            <Input id="remote-dsm-limit" inputMode="numeric" value={limit} onChange={e => setLimit(e.target.value.replace(/\D/g, "").slice(0, 1))} className="w-20 font-mono text-[12px]" />
            <span className="text-[11px] text-muted-foreground">DSM 자동 차단(기본 5분 10회)보다 낮게 두세요. 넘으면 5분간 NAS 확인을 멈추고, 비상용 로컬 로그인은 그대로 됩니다.</span>
          </div>
          <p className="text-[11px] text-muted-foreground">로그인할 때마다 NAS에 아이디·비밀번호·OTP를 확인만 하고 곧바로 DSM 세션을 종료합니다. NAS 비밀번호와 세션 ID는 저장하지 않습니다.</p>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">로그인 방식을 바꾸면 모든 원격 세션이 로그아웃됩니다.</span>
        <Button type="button" size="sm" variant="outline" disabled={busy || !dirty}
          onClick={() => void run("update", provider === "synology-dsm" ? { provider, dsmUrl: url, dsmCertSha256: pin, dsmAllowedUsers: allowedUsers, dsmFailureLimit: Number(limit) } : { provider })}>로그인 방식 저장</Button>
      </div>
    </div>
  );
}

/** Cap on the disk use of all remote uploads (sent ones too); the core refuses uploads past it (507). */
function UploadStorage({ status, busy, run }: { status: RemoteWebStatus; busy: boolean; run: Run }) {
  const saved = status.uploadStorageGb ?? REMOTE_UPLOAD_STORAGE.defaultGb;
  const [gb, setGb] = useState(String(saved));
  useEffect(() => setGb(String(saved)), [saved]);
  const value = Number(gb);
  const valid = gb.trim() !== "" && Number.isFinite(value) && value >= REMOTE_UPLOAD_STORAGE.minGb && value <= REMOTE_UPLOAD_STORAGE.maxGb;
  return (
    <div className="grid gap-2 rounded-lg border p-3 text-[12px]" data-testid="remote-web-upload-storage">
      <Label htmlFor="remote-upload-storage">원격 첨부 저장 한도</Label>
      <div className="flex items-center gap-2">
        <Input id="remote-upload-storage" inputMode="decimal" value={gb} onChange={e => setGb(e.target.value.replace(/[^\d.]/g, "").slice(0, 5))} className="w-20 font-mono text-[12px]" />
        <span>GB</span>
        <Button type="button" size="sm" variant="outline" disabled={busy || !valid || value === saved} onClick={() => void run("update", { uploadStorageGb: value })}>저장</Button>
      </div>
      <span className="text-[11px] text-muted-foreground">
        원격 웹으로 올린 첨부 파일(보낸 것 포함)의 합계 한도입니다({REMOTE_UPLOAD_STORAGE.minGb}~{REMOTE_UPLOAD_STORAGE.maxGb}GB, 기본 {REMOTE_UPLOAD_STORAGE.defaultGb}GB). 이 한도를 넘거나 PC 디스크 여유 공간이 {REMOTE_UPLOAD_STORAGE.minFreeBytes / 1024 ** 3}GB 미만이 되면 업로드를 거부합니다. 원격 첨부가 있는 채팅을 삭제하면 공간이 돌아옵니다.
      </span>
    </div>
  );
}

/** D1: folders under which remote users may create one new project folder. Empty = remote project creation off. */
function ProjectRoots({ status, busy, run }: { status: RemoteWebStatus; busy: boolean; run: Run }) {
  const saved = status.projectRoots ?? [];
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const save = (roots: { path: string; label: string }[]) => run("update", { projectRoots: roots.map(r => ({ id: "", label: r.label, path: r.path })) });
  return (
    <div className="grid gap-2 rounded-lg border p-3" data-testid="remote-web-project-roots">
      <div className="text-[12px] font-medium">원격 새 프로젝트 허용 위치</div>
      <p className="text-[11px] text-muted-foreground">원격 웹에서는 여기 지정한 폴더 바로 아래에 새 폴더를 하나 만들어서만 프로젝트를 만들 수 있습니다. 비어 있으면 원격 프로젝트 생성이 꺼집니다.</p>
      {saved.length > 0 && (
        <ul className="grid gap-1">
          {saved.map(r => (
            <li key={r.id} className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-[11.5px]">
              <span className="font-medium">{r.label}</span>
              {!r.fileId && <span className="text-destructive" title="보안 확인 정보가 없는 예전 등록입니다. 제거한 뒤 다시 추가하세요.">재등록 필요</span>}
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={r.path}>{r.path}</span>
              <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => void save(saved.filter(x => x.id !== r.id))}>제거</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-[1fr_140px_auto] gap-2">
        <Input aria-label="허용 위치 폴더 경로" placeholder="D:\AI" value={path} onChange={e => setPath(e.target.value)} spellCheck={false} className="font-mono text-[12px]" />
        <Input aria-label="허용 위치 이름" placeholder="표시 이름" value={label} onChange={e => setLabel(e.target.value)} />
        <Button type="button" size="sm" variant="outline" disabled={busy || !path.trim()} onClick={() => void save([...saved, { path: path.trim(), label: label.trim() }]).then(next => { if (next) { setPath(""); setLabel(""); } })}>추가</Button>
      </div>
    </div>
  );
}

export function RemoteWebDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [status, setStatus] = useState<RemoteWebStatus>();
  const [port, setPort] = useState("");
  const [origin, setOrigin] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState<RemoteWebAction>();
  const [error, setError] = useState<string>();
  const requestSeq = useRef(0);

  const run: Run = useCallback(async (action, input) => {
    const seq = ++requestSeq.current;
    setPending(action);
    setError(undefined);
    try {
      const next = await api.remoteWeb(action, input);
      if (seq !== requestSeq.current) return;
      setStatus(next);
      if (action === "status" || action === "update") { setPort(String(next.port)); setOrigin(next.publicOrigin); }
      if (action === "set-password") { setPassword(""); setConfirm(""); }
      return next;
    } catch (e) {
      if (seq === requestSeq.current) setError(errorMessage(e));
    } finally {
      if (seq === requestSeq.current) setPending(undefined);
    }
  }, []);

  useEffect(() => {
    setPassword("");
    setConfirm("");
    if (open) void run("status");
    else requestSeq.current += 1;
  }, [open, run]);

  const busy = !!pending;
  const portNumber = Number(port);
  const dirty = !!status && (portNumber !== status.port || origin.trim() !== status.publicOrigin);
  const passwordError = password && password.length < REMOTE_WEB_MIN_PASSWORD ? `${REMOTE_WEB_MIN_PASSWORD}자 이상 입력하세요.` : password && confirm && password !== confirm ? "두 비밀번호가 다릅니다." : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="원격 웹 접속" description="휴대폰·다른 PC의 브라우저에서 채팅을 보고 추가 지시·승인을 보냅니다." className="w-[min(640px,calc(100vw-32px))]" data-testid="remote-web-dialog">
        <div className="grid gap-4">
          <div className="rounded-lg border border-warning/40 bg-warning/8 p-3 text-[12px] leading-relaxed text-muted-foreground">
            <div className="mb-1 flex items-center gap-2 font-medium text-foreground"><KeyRound className="size-4 text-warning" /> 보안 안내</div>
            <p>원격 지시와 승인은 이 PC에서 관리자 권한으로 명령을 실행할 수 있습니다. 긴 비밀번호를 쓰고, 서버는 127.0.0.1에만 열리며 외부 접속은 HTTPS 리버스 프록시(Caddy)를 통해서만 받습니다.</p>
          </div>

          {status && (
            <div className="flex items-center gap-3 rounded-lg border p-3 text-[12px]" data-testid="remote-web-state">
              {status.error ? <CircleAlert className="size-4 text-destructive" /> : status.running ? <CircleCheck className="size-4 text-success" /> : <Globe className="size-4 text-muted-foreground" />}
              <div className="min-w-0 flex-1">
                <div className="font-medium">{status.running ? "실행 중" : status.enabled ? "시작하지 못함" : "꺼짐"}</div>
                <div className="truncate text-muted-foreground">
                  {status.running ? <>접속 주소 <span className="font-mono text-foreground">{status.publicOrigin}</span> · 내부 <span className="font-mono">127.0.0.1:{status.port}</span></> : status.passwordSet ? "켜면 원격 접속을 받습니다." : "먼저 비밀번호를 설정하세요."}
                </div>
              </div>
              <Switch checked={status.enabled} label="원격 웹 접속 사용" onChange={enabled => void run("update", { enabled })} />
            </div>
          )}
          {(status?.error || error) && <div role="alert" className="flex items-center gap-2 text-[12px] text-destructive" data-testid="remote-web-error"><CircleAlert className="size-4" />{error ?? status?.error}</div>}

          <div className="grid gap-3 rounded-lg border p-3">
            <div className="text-[12px] font-medium">연결 설정</div>
            <div className="grid grid-cols-[110px_1fr] gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="remote-web-port">내부 포트</Label>
                <Input id="remote-web-port" inputMode="numeric" value={port} onChange={e => setPort(e.target.value.replace(/\D/g, ""))} className="font-mono text-[12px]" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="remote-web-origin">공개 접속 주소</Label>
                <Input id="remote-web-origin" value={origin} onChange={e => setOrigin(e.target.value)} spellCheck={false} placeholder="https://ai.damkina.net" className="font-mono text-[12px]" />
              </div>
            </div>
            {status && (
              <label className="flex items-start gap-2 text-[12px]">
                <input type="checkbox" className="mt-0.5" checked={status.trustProxy} disabled={busy} onChange={e => void run("update", { trustProxy: e.target.checked })} />
                <span>이 PC의 Caddy를 거쳐 접속함 (Caddy가 넣는 X-ChatterBox-Client-IP로 접속자 IP 구분)
                  <span className="block text-[11px] text-muted-foreground">Caddy 사이트 블록에 docs/remote-web.Caddyfile의 header_up 줄이 있어야 합니다. 끄면 모든 원격 접속이 127.0.0.1 하나로 집계되어 IP별 잠금이 전체 잠금처럼 동작합니다.</span>
                </span>
              </label>
            )}
            <p className="text-[11px] text-muted-foreground">공개 주소와 다른 출처의 요청은 거부합니다. 주소를 바꾸면 모든 원격 세션이 로그아웃됩니다. Caddy 설정은 docs/remote-web.md를 참고하세요.</p>
            <div className="flex justify-end">
              <Button type="button" size="sm" variant="outline" disabled={busy || !dirty} onClick={() => void run("update", { port: portNumber, publicOrigin: origin })}>설정 저장</Button>
            </div>
          </div>

          {status && <LoginMethod status={status} busy={busy} run={run} />}

          <div className="grid gap-2 rounded-lg border p-3">
            <div className="flex items-center gap-2 text-[12px] font-medium">{status?.provider === "synology-dsm" ? "비상용 로컬 비밀번호" : "원격 접속 비밀번호"} <Badge>{status?.passwordSet ? "설정됨" : "미설정"}</Badge></div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input type="password" aria-label="새 비밀번호" autoComplete="new-password" placeholder={`새 비밀번호 (${REMOTE_WEB_MIN_PASSWORD}자 이상)`} value={password} onChange={e => setPassword(e.target.value)} />
              <Input type="password" aria-label="새 비밀번호 확인" autoComplete="new-password" placeholder="비밀번호 확인" value={confirm} onChange={e => setConfirm(e.target.value)} />
            </div>
            {passwordError && <div className="text-[11.5px] text-destructive">{passwordError}</div>}
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">해시(scrypt)만 저장하며, 바꾸면 모든 원격 세션이 로그아웃됩니다.</p>
              <Button type="button" size="sm" disabled={busy || !password || !!passwordError || password !== confirm} onClick={() => void run("set-password", { password })}><KeyRound /> 저장</Button>
            </div>
          </div>

          <div className="grid gap-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2 text-[12px] font-medium">
              <span>활성 세션 {status ? `(${status.sessions.length})` : ""}</span>
              <div className="flex gap-1.5">
                <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void run("status")}><RefreshCw /> 새로고침</Button>
                <Button type="button" size="xs" variant="outline" disabled={busy || !status?.sessions.length} onClick={() => void run("logout-all")}><LogOut /> 전체 로그아웃</Button>
              </div>
            </div>
            {status?.sessions.length ? (
              <ul className="grid gap-1.5">
                {status.sessions.map(session => (
                  <li key={session.id} className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-[11.5px]">
                    <div className="min-w-0 flex-1">
                      <div className="truncate"><span className="font-medium">{session.user === "local" ? "로컬 비밀번호" : session.user}</span> · <span className="font-mono">{session.ip}</span></div>
                      <div className="truncate text-muted-foreground" title={session.userAgent}>{session.userAgent || "알 수 없는 브라우저"} · {timeAgo(session.lastSeenAt)} 사용</div>
                    </div>
                    <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => void run("revoke", { sessionId: session.id })}>로그아웃</Button>
                  </li>
                ))}
              </ul>
            ) : <div className="text-[11.5px] text-muted-foreground">로그인한 원격 세션이 없습니다. 세션은 앱을 다시 시작하면 모두 끝납니다.</div>}
          </div>

          {status && (
            <label className="flex items-start gap-2 rounded-lg border p-3 text-[12px]" data-testid="remote-web-internet-emergency">
              <input type="checkbox" className="mt-0.5" checked={!!status.allowInternetEmergency} disabled={busy || (!status.emergencyPasswordLong && !status.allowInternetEmergency)}
                onChange={e => void run("update", { allowInternetEmergency: e.target.checked })} />
              <span>인터넷에서도 비상용 로그인 허용
                <span className="block text-[11px] text-muted-foreground">기본은 꺼짐: 비상용 로컬 비밀번호는 OTP가 없어 LAN(사설 IP)·이 PC에서만 받습니다. 켜려면 비상용 비밀번호가 20자 이상이어야 하며{status.emergencyPasswordLong ? "" : " (지금 비밀번호는 20자 미만이라 켤 수 없습니다)"}, 인터넷의 누구나 이 비밀번호로 로그인을 시도할 수 있게 됩니다.</span>
              </span>
            </label>
          )}

          {status && <UploadStorage status={status} busy={busy} run={run} />}

          {status && <ProjectRoots status={status} busy={busy} run={run} />}

          {!!status?.audit?.length && (
            <details className="rounded-lg border p-3 text-[11.5px]" data-testid="remote-web-audit">
              <summary className="cursor-pointer text-[12px] font-medium">최근 원격 변경 {status.audit.length}건</summary>
              <ul className="mt-2 grid gap-1">
                {status.audit.map((a, i) => (
                  <li key={i} className="grid gap-0.5 rounded-md bg-muted/50 px-2 py-1.5">
                    <div><span className="font-medium">{a.action}</span> · {a.target} · {a.user} · <span className="font-mono">{a.ip}</span> · {timeAgo(a.at)}</div>
                    {a.detail && <div className="break-all text-muted-foreground">{a.detail}</div>}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {!!status?.loginFailures.length && (
            <details className="rounded-lg border p-3 text-[11.5px]" data-testid="remote-web-login-failures">
              <summary className="cursor-pointer text-[12px] font-medium">최근 로그인 실패 {status.loginFailures.length}건 <span className="font-normal text-muted-foreground">· 실제 원인은 이 앱에서만 보입니다</span></summary>
              <ul className="mt-2 grid gap-1">
                {status.loginFailures.map((f, i) => (
                  <li key={i} className="grid gap-0.5 rounded-md bg-muted/50 px-2 py-1.5">
                    <div><span className="font-medium">{f.user}</span> · <span className="font-mono">{f.ip}</span> · {timeAgo(f.at)}</div>
                    <div className="text-muted-foreground">{f.detail}</div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>닫기</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
