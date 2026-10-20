import { useEffect, useState } from "react";
import { CircleAlert, FolderPlus, Loader2, MessageSquarePlus, RotateCcw, Workflow, X } from "lucide-react";
import { isAIStudioModel } from "../../shared/aistudio";
import { AGENT_LABEL, GEMINI_WEB_MODEL } from "../../shared/types";
import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { ProjectDialog } from "./components/ProjectDialog";
import { Button, TooltipProvider } from "./components/ui";
import { cn, errorMessage } from "./lib/utils";

export function App() {
  const ready = useStore((s) => s.ready);
  const init = useStore((s) => s.init);
  const selection = useStore((s) => s.selection);
  const chats = useStore((s) => s.chats);
  const projects = useStore((s) => s.projects);
  const cli = useStore((s) => s.cli);
  const refreshCli = useStore((s) => s.refreshCli);
  const toast = useStore((s) => s.toast);
  const [checkingCli, setCheckingCli] = useState(false);
  const [newProject, setNewProject] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  const chat = selection ? chats.find((c) => c.id === selection.chatId) : undefined;
  const project = chat ? projects.find((p) => p.id === chat.projectId) : undefined;
  const workerGemini = chat?.geminiModelOverride ?? project?.settings.geminiModel;
  const orchestrator = chat?.orchestratorModelOverride ?? project?.settings.orchestratorModel;
  const orchestratorGemini = orchestrator?.startsWith("gemini:") ? orchestrator.slice("gemini:".length) : "";
  const managedGemini = [workerGemini, orchestratorGemini].some((model) => model === GEMINI_WEB_MODEL || isAIStudioModel(model));
  const missing = cli.filter((c) => c.agent !== "deepseek" && !c.path && !(c.agent === "gemini" && managedGemini));

  if (!ready)
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );

  return (
    <TooltipProvider delayDuration={400}>
      <div className="grid h-full grid-cols-[288px_1fr]">
        <Sidebar onNewProject={() => setNewProject(true)} />
        <main className="flex min-h-0 min-w-0 flex-col">
          {missing.length > 0 && (
            <div data-testid="cli-warning" className="flex items-start gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-[12.5px]">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <div className="min-w-0 flex-1 space-y-0.5">
                {missing.map((m) => (
                  <div key={m.agent}>{m.error ?? `${AGENT_LABEL[m.agent]} CLI를 찾지 못했습니다.`}</div>
                ))}
              </div>
              <Button variant="outline" size="xs" disabled={checkingCli} onClick={async () => {
                setCheckingCli(true);
                try { await refreshCli(); }
                catch (error) { toast(errorMessage(error)); }
                finally { setCheckingCli(false); }
              }}>
                <RotateCcw className={cn(checkingCli && "animate-spin")} /> 설치 경로 다시 확인
              </Button>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {chat && project ? (
              <ChatView key={chat.id} chat={chat} project={project} node={selection?.node} />
            ) : (
              <Welcome hasProjects={projects.length > 0} onNewProject={() => setNewProject(true)} />
            )}
          </div>
        </main>
      </div>
      <ProjectDialog open={newProject} onOpenChange={setNewProject} />
      <Toasts />
    </TooltipProvider>
  );
}

function Welcome({ hasProjects, onNewProject }: { hasProjects: boolean; onNewProject: () => void }) {
  const projects = useStore((s) => s.projects);
  const createChat = useStore((s) => s.createChat);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-claude via-gemini to-gpt text-white shadow-lg">
        <Workflow className="size-7" />
      </div>
      <div className="space-y-1.5">
        <div className="text-lg font-semibold">Claude·GPT·Gemini·Grok·DeepSeek가 함께 일하는 채팅</div>
        <div className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
          프로젝트(작업 폴더)를 만들고 채팅에 지시하면, 마스터가 일의 양에 맞춰 클로드·지피티·제미나이·그록·딥시크 작업자를 꾸리고 구현과 리뷰를 나눠 맡긴 뒤 결과를 정리해 보고합니다.
        </div>
      </div>
      <div className="flex gap-2">
        <Button onClick={onNewProject}>
          <FolderPlus /> 새 프로젝트
        </Button>
        {hasProjects && (
          <Button variant="outline" onClick={() => void createChat(projects[projects.length - 1].id)}>
            <MessageSquarePlus /> 최근 프로젝트에 새 채팅
          </Button>
        )}
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className={cn(
            "pointer-events-auto flex items-start gap-2 rounded-lg border bg-card p-3 text-[13px] shadow-xl",
            t.tone === "error" && "border-destructive/50",
          )}
        >
          {t.tone === "error" && <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />}
          <div className="min-w-0 flex-1 break-words">{t.text}</div>
          <button onClick={() => dismiss(t.id)} aria-label="닫기" className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
