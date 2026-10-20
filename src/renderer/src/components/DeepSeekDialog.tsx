import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { DEEPSEEK_MODEL, type DeepSeekAction, type DeepSeekStatus } from "../../../shared/deepseek";
import { api, errorMessage } from "../lib/utils";
import { Badge, Button, Dialog, DialogContent, DialogFooter, Input, Label } from "./ui";

const STATE_LABEL: Record<DeepSeekStatus["state"], string> = {
  unconfigured: "키 미설정",
  configured: "키 설정됨",
  ready: "연결 확인됨",
  error: "오류",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUseModel?: (model: string) => void;
}

export function DeepSeekDialog({ open, onOpenChange, onUseModel }: Props) {
  const [status, setStatus] = useState<DeepSeekStatus>();
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState<DeepSeekAction>();
  const [error, setError] = useState<string>();
  const requestSeq = useRef(0);

  const run = useCallback(async (action: DeepSeekAction, input?: { apiKey?: string }) => {
    const seq = ++requestSeq.current;
    setPending(action);
    setError(undefined);
    try {
      const next = await api.deepSeek(action, input);
      if (seq !== requestSeq.current) return;
      setStatus(next);
      if (action !== "status") setApiKey("");
    } catch (e) {
      if (seq === requestSeq.current) setError(errorMessage(e));
    } finally {
      if (seq === requestSeq.current) setPending(undefined);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      requestSeq.current += 1;
      setApiKey("");
      setPending(undefined);
      return;
    }
    setApiKey("");
    void run("status");
  }, [open, run]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      requestSeq.current += 1;
      setApiKey("");
      setPending(undefined);
    }
    onOpenChange(nextOpen);
  };

  const save = () => {
    // An empty field deliberately keeps the stored key; the main process never returns it.
    void run("save", apiKey.trim() ? { apiKey } : undefined);
  };

  const busy = !!pending;
  const preferredModel = status?.models.includes(DEEPSEEK_MODEL) ? DEEPSEEK_MODEL : status?.models[0] ?? DEEPSEEK_MODEL;
  const useModelLabel = preferredModel === DEEPSEEK_MODEL ? "Flash 모델 사용" : `${preferredModel} 사용`;
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent title="DeepSeek API" description="API 키를 로컬에 저장하고 모델 목록을 확인합니다." className="w-[min(620px,calc(100vw-32px))]" data-testid="deepseek-dialog">
        <div className="grid gap-4">
          <div className="rounded-lg border border-warning/40 bg-warning/8 p-3 text-[12px] leading-relaxed text-muted-foreground">
            <div className="mb-1 flex items-center gap-2 font-medium text-foreground"><KeyRound className="size-4 text-warning" /> API 사용 안내</div>
            <p>DeepSeek API 키는 Windows 보안 저장소로 암호화됩니다. 대화와 코딩 요청은 DeepSeek API 요금이 적용됩니다. 모델 확인은 생성 없이 연결만 확인합니다.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="deepseek-api-key">DeepSeek API 키</Label>
            <div className="flex gap-2">
              <Input
                id="deepseek-api-key"
                data-testid="deepseek-api-key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={status?.apiKeySet ? "기존 키 유지 · 새 키를 입력하면 교체" : "sk-…"}
                autoComplete="new-password"
                spellCheck={false}
                className="font-mono text-[12px]"
              />
              <Button type="button" onClick={save} disabled={busy} data-testid="deepseek-save"><KeyRound /> 저장</Button>
            </div>
          </div>
          {status && (
            <div className="grid gap-2 rounded-lg border p-3 text-[12px]" data-testid="deepseek-status">
              <div className="flex items-center gap-2">
                {status.state === "error" ? <CircleAlert className="size-4 text-destructive" /> : status.state === "ready" ? <CircleCheck className="size-4 text-success" /> : <KeyRound className="size-4 text-muted-foreground" />}
                <span className="font-medium">상태</span>
                <Badge className={status.state === "error" ? "border-destructive/40 text-destructive" : status.state === "ready" ? "border-success/40 text-success" : undefined}>{STATE_LABEL[status.state]}</Badge>
                <span className="text-muted-foreground">{status.apiKeySet ? "키 저장됨" : "저장된 키 없음"}</span>
                <Button type="button" size="xs" variant="outline" className="ml-auto" onClick={() => void run("check")} disabled={busy || !status.apiKeySet} data-testid="deepseek-check"><RefreshCw /> 모델 확인</Button>
              </div>
              {status.models.length > 0 ? (
                <div className="flex flex-wrap gap-1.5" data-testid="deepseek-models">
                  {status.models.map((model) => <Badge key={model} className="font-mono">{model}</Badge>)}
                </div>
              ) : <div className="text-muted-foreground">확인된 모델이 없습니다.</div>}
              {status.checkedAt && <div className="text-[11px] text-muted-foreground">{new Date(status.checkedAt).toLocaleString("ko-KR")} 확인</div>}
              {(status.error || error) && <div className="text-destructive" data-testid="deepseek-error">{status.error ?? error}</div>}
            </div>
          )}
          {error && !status?.error && <div role="alert" className="flex items-center gap-2 text-[12px] text-destructive"><CircleAlert className="size-4" />{error}</div>}
          <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/20 p-3">
            <div>
              <div className="text-[12px] font-medium">저장된 키 삭제</div>
              <div className="text-[11.5px] text-muted-foreground">삭제 후 DeepSeek 작업자는 API 키가 없어 사용할 수 없습니다.</div>
            </div>
            <Button type="button" variant="outline" onClick={() => void run("remove")} disabled={busy || !status?.apiKeySet} data-testid="deepseek-remove"><Trash2 /> 키 삭제</Button>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>닫기</Button>
          {onUseModel && status?.state === "ready" && <Button type="button" onClick={() => { onUseModel(preferredModel); handleOpenChange(false); }} data-testid="deepseek-use-model">{useModelLabel}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
