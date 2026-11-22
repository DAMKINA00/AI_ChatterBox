// Remote web login page (NAS account with OTP, or the local emergency password). Shared by the
// desktop-style page (desktop-main.tsx) and the classic remote page (RemoteApp.tsx).
import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { request, setCsrf } from "./api";
import { Btn, errorText, FIELD } from "./ui";

export function Login({ onDone }: { onDone: () => void }) {
  const [configured, setConfigured] = useState<"local" | "synology-dsm">();
  const [emergency, setEmergency] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  useEffect(() => { request<{ provider: "local" | "synology-dsm" }>("/api/auth-info").then(r => setConfigured(r.provider)).catch(() => setConfigured("local")); }, []);
  const nas = configured === "synology-dsm" && !emergency;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      const { csrf } = await request<{ csrf: string }>("/api/login", nas ? { provider: "synology-dsm", username, password, otp } : { provider: "local", password });
      setCsrf(csrf);
      setPassword("");
      setOtp("");
      onDone();
    } catch (err) { setError(errorText(err)); }
    finally { setPending(false); }
  };
  if (!configured) return <div className="flex h-dvh items-center justify-center text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /></div>;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <form onSubmit={submit} className="grid w-full max-w-sm gap-3 rounded-xl border bg-card p-6 shadow-lg">
        <h1 className="text-lg font-semibold">AI ChatterBox 원격 접속</h1>
        <p className="text-[12.5px] text-muted-foreground">{nas ? "NAS(Synology DSM) 계정으로 로그인합니다." : configured === "synology-dsm" ? "비상용 로컬 비밀번호로 로그인합니다." : "원격 접속 비밀번호를 입력하세요."}</p>
        {nas && <>
          <label htmlFor="remote-username" className="text-[13px] font-medium">NAS 아이디</label>
          <input id="remote-username" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus value={username} onChange={e => setUsername(e.target.value)} className={FIELD} />
        </>}
        <label htmlFor="remote-password" className="text-[13px] font-medium">{nas ? "NAS 비밀번호" : "비밀번호"}</label>
        <input id="remote-password" type="password" autoComplete="current-password" autoFocus={!nas} value={password} onChange={e => setPassword(e.target.value)} className={FIELD} />
        {nas && <>
          <label htmlFor="remote-otp" className="text-[13px] font-medium">2단계 인증 코드 <span className="font-normal text-muted-foreground">(사용 중이면)</span></label>
          <input id="remote-otp" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6,8}" maxLength={8} value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, ""))} className={FIELD} />
        </>}
        {error && <div role="alert" className="text-[13px] text-destructive">{error}</div>}
        <Btn type="submit" disabled={pending || !password || (nas && !username)}>{pending ? <LoaderCircle className="animate-spin" /> : null} 로그인</Btn>
        {configured === "synology-dsm" && (
          <button type="button" className="text-[12px] text-muted-foreground underline underline-offset-2" onClick={() => { setEmergency(v => !v); setError(undefined); }}>
            {emergency ? "NAS 계정으로 로그인" : "NAS에 연결할 수 없을 때: 비상용 로컬 비밀번호로 로그인"}
          </button>
        )}
      </form>
    </main>
  );
}
