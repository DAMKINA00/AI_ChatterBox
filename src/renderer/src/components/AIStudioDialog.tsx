import { useEffect, useRef, useState } from "react";
import { CircleAlert, ExternalLink, Loader2, RefreshCw, Save, Settings2, Sparkles, Square, Zap } from "lucide-react";
import type { AIStudioAction, AIStudioAccount, AIStudioStatus } from "../../../shared/aistudio";
import { api, errorMessage } from "../lib/utils";
import { Button, Dialog, DialogContent, DialogFooter, Input, Label } from "./ui";
import { GeminiWebDialog } from "./GeminiWebDialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Selects the configured Argon model only after a live, exact model check. */
  onUseModel?: (model: string) => void;
}

interface FormState {
  baseUrl: string;
  model: string;
  executable: string;
  apiKey: string;
  videoEnabled: boolean;
}

const DEFAULT_FORM: FormState = {
  baseUrl: "http://127.0.0.1:2048",
  model: "gemini-4-argon",
  executable: "",
  apiKey: "",
  videoEnabled: false,
};

function formFrom(status: AIStudioStatus): FormState {
  return {
    baseUrl: status.settings.baseUrl,
    model: status.settings.model,
    executable: status.settings.executable,
    apiKey: "",
    videoEnabled: status.settings.videoEnabled,
  };
}

function isRunning(status: AIStudioStatus | null): boolean {
  return status?.state.toUpperCase() === "RUNNING";
}

function untilText(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("ko-KR");
}

function accountHasModel(account: AIStudioAccount, model: string): boolean {
  return account.models.includes(model);
}

function AccountCard({
  account,
  model,
  pending,
  onRefresh,
  onEnable,
}: {
  account: AIStudioAccount;
  model: string;
  pending: boolean;
  onRefresh: () => void;
  onEnable: (enabled: boolean) => void;
}) {
  const available = accountHasModel(account, model);
  return (
    <section className="grid gap-2 rounded-lg border bg-card p-3" data-testid="aistudio-account" data-account-id={account.id}>
      <div className="flex items-center gap-2">
        <span className="size-2 shrink-0 rounded-full bg-primary" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{account.label || account.id}</span>
        <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <input type="checkbox" checked={account.enabled} disabled={pending} onChange={(event) => onEnable(event.target.checked)} aria-label={`${account.label || account.id} 사용`} />
          사용
        </label>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
        <span>등급: {account.benefit_tier || "정보 없음"}</span>
        <span>상태: {account.state || "정보 없음"}</span>
        <span className={available ? "text-emerald-500" : "text-muted-foreground"}>Argon: {available ? "사용 가능" : "사용 불가"}</span>
        <span className="truncate" title={account.message}>{account.message || ""}</span>
      </div>
      <Button type="button" size="xs" variant="outline" disabled={pending} onClick={onRefresh} className="justify-self-start">
        <RefreshCw /> 계정 새로고침
      </Button>
    </section>
  );
}

export function AIStudioDialog({ open, onOpenChange, onUseModel }: Props) {
  const [status, setStatus] = useState<AIStudioStatus | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [webOpen, setWebOpen] = useState(false);
  const statusInFlight = useRef(false);
  const formDirty = useRef(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    formDirty.current = false;
    const refresh = async () => {
      if (statusInFlight.current) return;
      statusInFlight.current = true;
      try {
        const next = await api.aiStudio("status");
        if (!active) return;
        setStatus(next);
        if (!formDirty.current) setForm(formFrom(next));
        setError(next.error);
      } catch (e) {
        if (active) setError(errorMessage(e));
      } finally {
        statusInFlight.current = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [open]);

  const run = async (action: AIStudioAction, input?: Parameters<typeof api.aiStudio>[1]) => {
    setPending(action);
    setError(undefined);
    try {
      const next = await api.aiStudio(action, input);
      setStatus(next);
      if (action === "save") {
        formDirty.current = false;
        setForm(formFrom(next));
      } else if (action === "status" && !formDirty.current) setForm(formFrom(next));
      setError(next.error);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(undefined);
    }
  };

  const save = () => void run("save", {
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    executable: form.executable.trim(),
    ...(form.apiKey.trim() ? { apiKey: form.apiKey } : {}),
    videoEnabled: form.videoEnabled,
  });
  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    formDirty.current = true;
    setForm((current) => ({ ...current, [key]: value }));
  };
  const canUseModel = !!onUseModel
    && isRunning(status)
    && !!status?.settings.model
    && !!status.models.some((model) => model.id === status.settings.model)
    && !!status?.accounts.some((account) => account.enabled
      && account.models.includes(status.settings.model)
      && !["disabled", "auth_required", "unavailable"].includes(account.state.trim().toLowerCase()));

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent title="AI Studio · Argon" description="AIStudio2API 연결과 계정 라우팅을 관리합니다." className="w-[min(900px,calc(100vw-32px))]" data-testid="aistudio-dialog">
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3 text-[12px]" data-testid="aistudio-status">
              <span className="font-medium">상태: {status?.state ?? "확인 중"}</span>
              {status?.version && <span className="text-muted-foreground">버전 {status.version}</span>}
              {status?.settings.hasApiKey && <span className="text-emerald-500">API 키 저장됨</span>}
              <Button type="button" variant="ghost" size="xs" className="ml-auto" disabled={!!pending} onClick={() => void run("status")}>
                <RefreshCw className={pending === "status" ? "animate-spin" : ""} /> 상태 새로고침
              </Button>
            </div>
            {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/50 p-3 text-[12px] text-destructive"><CircleAlert className="mt-0.5 size-4 shrink-0" />{error}</div>}

            <div className="grid gap-3 rounded-lg border p-3.5">
              <div className="text-[12px] font-medium text-muted-foreground">연결 설정</div>
              <label className="grid gap-1.5"><Label htmlFor="aistudio-base-url">백엔드 주소</Label><Input id="aistudio-base-url" value={form.baseUrl} onChange={(event) => updateForm("baseUrl", event.target.value)} placeholder="http://127.0.0.1:2048" className="font-mono text-[12px]" /></label>
              <label className="grid gap-1.5"><Label htmlFor="aistudio-executable">실행 파일</Label><Input id="aistudio-executable" value={form.executable} onChange={(event) => updateForm("executable", event.target.value)} placeholder="C:\\Apps\\AIStudio2API\\aistudio2api.exe" className="font-mono text-[12px]" /></label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1.5"><Label htmlFor="aistudio-model">모델 ID</Label><Input id="aistudio-model" value={form.model} onChange={(event) => updateForm("model", event.target.value)} className="font-mono text-[12px]" /></label>
                <label className="grid gap-1.5"><Label htmlFor="aistudio-api-key">API 키</Label><Input id="aistudio-api-key" type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => updateForm("apiKey", event.target.value)} placeholder={status?.settings.hasApiKey ? "저장된 키를 유지하려면 비워 두세요" : "저장할 API 키"} className="font-mono text-[12px]" /></label>
              </div>
              <label className="flex items-start gap-2 text-[12px]">
                <input type="checkbox" checked={form.videoEnabled} onChange={(event) => updateForm("videoEnabled", event.target.checked)} />
                <span><span className="font-medium">영상 생성 사용</span><span className="block text-muted-foreground">명시적으로 켠 경우에만 영상 생성을 사용합니다. 영상 생성에는 별도 사용량과 제한이 적용될 수 있습니다.</span></span>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={save} disabled={!!pending}><Save /> 저장</Button>
                <Button type="button" variant="outline" onClick={() => void run("launch")} disabled={!!pending}><Zap /> 매니저 실행</Button>
                <Button type="button" variant="outline" onClick={() => void run("start")} disabled={!!pending}><Zap /> 서비스 시작</Button>
                <Button type="button" variant="outline" onClick={() => void run("stop")} disabled={!!pending}><Square /> 서비스 중지</Button>
                <Button type="button" variant="outline" onClick={() => void run("open")} disabled={!!pending}><ExternalLink /> 매니저 열기</Button>
                <Button type="button" variant="outline" onClick={() => void run("export-antigravity")} disabled={!!pending}><Settings2 /> Antigravity 설정 내보내기</Button>
              </div>
            </div>

            <div className="grid gap-3 rounded-lg border p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <div><div className="text-[12px] font-medium text-muted-foreground">Google 계정</div><div className="text-[11.5px] text-muted-foreground">로그인과 계정 추가는 기존 Gemini Web 관리기에서 처리하고, AI Studio는 같은 계정을 사용합니다.</div></div>
                <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => setWebOpen(true)}><Sparkles /> Gemini Web 계정 관리</Button>
              </div>
              <div className="text-[12px] text-muted-foreground">등록 {status?.accounts.length ?? 0}/10 · 계정별 상태와 Argon 사용 가능 여부</div>
              <div className="grid max-h-64 gap-2 overflow-y-auto pr-1 sm:grid-cols-2" data-testid="aistudio-accounts">
                {status?.accounts.map((account) => <AccountCard key={account.id} account={account} model={status.settings.model} pending={!!pending} onRefresh={() => void run("refresh", { accountId: account.id })} onEnable={(enabled) => void run("enable", { accountId: account.id, enabled })} />)}
                {!status && <p className="text-[12px] text-muted-foreground">계정을 불러오는 중입니다.</p>}
                {status && !status.accounts.length && <p className="text-[12px] text-muted-foreground">연결된 계정이 없습니다. Gemini Web 계정 관리에서 연결하세요.</p>}
              </div>
            </div>

            <div className="grid gap-2 rounded-lg border p-3.5">
              <div className="text-[12px] font-medium text-muted-foreground">쿨다운</div>
              {status?.cooldowns.length ? status.cooldowns.map((cooldown) => (
                <div key={`${cooldown.account_id}:${cooldown.model_id}:${cooldown.channel}`} className="grid gap-0.5 rounded-md bg-muted/30 px-2.5 py-2 text-[11.5px] sm:grid-cols-[1fr_auto]">
                  <span>{cooldown.account_label || cooldown.account_id} · {cooldown.model_id} · {cooldown.channel}</span>
                  <span className="text-muted-foreground">{untilText(cooldown.until)} 초기화{cooldown.reason ? ` · ${cooldown.reason}` : ""}</span>
                </div>
              )) : <p className="text-[12px] text-muted-foreground">현재 쿨다운이 없습니다.</p>}
            </div>
          </div>
          <DialogFooter>
            {pending && <Loader2 className="mr-auto size-4 animate-spin" aria-label="AI Studio 처리 중" />}
            {onUseModel && <Button type="button" disabled={!canUseModel || !!pending} onClick={() => { if (status) onUseModel(`aistudio:${status.settings.model}`); onOpenChange(false); }} data-testid="aistudio-use-model"><Sparkles /> Argon 모델 사용</Button>}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>닫기</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <GeminiWebDialog open={webOpen} onOpenChange={setWebOpen} />
    </>
  );
}
