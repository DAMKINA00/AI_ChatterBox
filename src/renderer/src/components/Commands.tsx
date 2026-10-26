import { APPROVAL_MODE_LABEL, AGENT_LABEL, MASTER_LABEL, parseOrchestrator, type Chat, type Project, type OrchestratorModel } from "../../../shared/types";
import { pickUsage } from "../../../shared/usage";
import { useStore } from "../store";
import { defaultEffortForModel, EffortPicker, effortLabel } from "./EffortPicker";
import { ModelPicker } from "./ModelPicker";
import { Dialog, DialogContent } from "./ui";

export interface SlashCommand {
  name: string;
  /** Argument hint; commands with args are filled into the box instead of running at once. */
  args?: string;
  needsArg?: boolean;
  desc: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "plan", args: "<지시>", needsArg: true, desc: "계획만 세우고, 확인한 뒤 실행" },
  { name: "goal", args: "<목표> | clear", desc: "채팅 목표를 정하고 끝날 때까지 진행" },
  { name: "review", args: "[요청]", desc: "커밋되지 않은 변경을 작업자에게 리뷰" },
  { name: "status", desc: "모델·대화·사용량 보기" },
  { name: "model", desc: "이 채팅의 모델 바꾸기" },
  { name: "new", desc: "이 프로젝트에 새 채팅" },
  { name: "stop", desc: "진행 중인 작업 중지" },
  { name: "compact", desc: "마스터 대화 압축" },
];

/** /status and /model: models (changeable), conversations, approval mode, usage, goal. */
export function StatusDialog({ open, onOpenChange, chat, project }: { open: boolean; onOpenChange: (o: boolean) => void; chat: Chat; project: Project }) {
  const updateChat = useStore((s) => s.updateChat);
  const usage = useStore((s) => s.usage);
  const agents = useStore((s) => s.agents[chat.id]);
  const models = useStore((s) => s.models);
  const orch = parseOrchestrator(chat.orchestratorModelOverride ?? project.settings.orchestratorModel);
  const claudeModel = chat.claudeModelOverride ?? project.settings.claudeModel;
  const codexModel = chat.codexModelOverride ?? project.settings.codexModel;
  const geminiModel = chat.geminiModelOverride ?? project.settings.geminiModel;
  const grokModel = chat.grokModelOverride ?? project.settings.grokModel;
  const deepseekModel = chat.deepseekModelOverride ?? project.settings.deepseekModel;
  const row = (label: React.ReactNode, value: React.ReactNode) => (
    <div className="grid grid-cols-[120px_1fr] items-center gap-3 text-[13px]">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0">{value}</div>
    </div>
  );
  const id = (v: string | null) => <span className="font-mono text-[12px] break-all">{v ?? "아직 없음"}</span>;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="채팅 상태" description={`${project.name} · ${chat.title}`} className="w-[600px]">
        <div className="grid gap-3">
          <div className="text-[12px] font-medium text-muted-foreground">모델·추론 수준 (다음 지시부터 적용)</div>
          {row(
            <span>{MASTER_LABEL}</span>,
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <ModelPicker
                agents={["claude", "codex", "gemini", "grok", "deepseek"]}
                ariaLabel="상태: 마스터 모델"
                value={chat.orchestratorModelOverride ?? project.settings.orchestratorModel}
                inherited={chat.orchestratorModelOverride === null}
                onChange={(v) => {
                  const next = parseOrchestrator(v);
                  void updateChat(chat.id, {
                    orchestratorModelOverride: v as OrchestratorModel,
                    orchestratorEffortOverride: defaultEffortForModel(models, next.agent, next.model, false),
                  });
                }}
                onReset={() => void updateChat(chat.id, { orchestratorModelOverride: null })}
              />
              <EffortPicker
                agent={orch.agent}
                model={orch.model}
                value={chat.orchestratorEffortOverride ?? project.settings.orchestratorEffort ?? "auto"}
                inherited={chat.orchestratorEffortOverride === null}
                onChange={(v) => void updateChat(chat.id, { orchestratorEffortOverride: v })}
                onReset={() => void updateChat(chat.id, { orchestratorEffortOverride: null })}
                resetLabel={`프로젝트 값 사용 (${effortLabel(project.settings.orchestratorEffort ?? "auto")})`}
                ariaLabel="상태: 마스터 추론 수준"
              />
            </div>,
          )}
          {row(
            <span>클로드 작업자</span>,
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <ModelPicker
                agents={["claude"]}
                ariaLabel="상태: 클로드 모델"
                value={claudeModel}
                inherited={chat.claudeModelOverride === null}
                onChange={(v) => void updateChat(chat.id, { claudeModelOverride: v })}
                onReset={() => void updateChat(chat.id, { claudeModelOverride: null })}
              />
            </div>,
          )}
          {row(
            <span>지피티 작업자</span>,
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <ModelPicker
                agents={["codex"]}
                ariaLabel="상태: 지피티 모델"
                value={codexModel}
                inherited={chat.codexModelOverride === null}
                onChange={(v) => void updateChat(chat.id, { codexModelOverride: v })}
                onReset={() => void updateChat(chat.id, { codexModelOverride: null })}
              />
            </div>,
          )}
          {row(
            <span>제미나이 작업자</span>,
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <ModelPicker
                agents={["gemini"]}
                ariaLabel="상태: 제미나이 모델"
                value={geminiModel}
                inherited={chat.geminiModelOverride === null}
                onChange={(v) => void updateChat(chat.id, { geminiModelOverride: v })}
                onReset={() => void updateChat(chat.id, { geminiModelOverride: null })}
              />
            </div>,
          )}
          {row(
            <span>그록 작업자</span>,
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <ModelPicker
                agents={["grok"]}
                ariaLabel="상태: 그록 모델"
                value={grokModel}
                inherited={chat.grokModelOverride === null}
                onChange={(v) => void updateChat(chat.id, { grokModelOverride: v })}
                onReset={() => void updateChat(chat.id, { grokModelOverride: null })}
              />
            </div>,
          )}
          {row(
            <span>딥시크 작업자</span>,
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <ModelPicker
                agents={["deepseek"]}
                ariaLabel="상태: 딥시크 모델"
                value={deepseekModel}
                inherited={chat.deepseekModelOverride === null}
                onChange={(v) => void updateChat(chat.id, { deepseekModelOverride: v })}
                onReset={() => void updateChat(chat.id, { deepseekModelOverride: null })}
              />
            </div>,
          )}
          <div className="mt-1 text-[12px] font-medium text-muted-foreground">대화</div>
          {row(MASTER_LABEL, orch.agent === "claude" ? id(chat.orchClaudeSessionId) : orch.agent === "codex" ? id(chat.orchCodexThreadId) : `${AGENT_LABEL[orch.agent]} 대화는 연결 방식별로 독립 보관됩니다.`)}
          {(agents ?? []).map((a) => row(a.nickname + (a.status === "released" ? " (해제)" : ""), id(a.sessionId)))}
          <div className="mt-1 text-[12px] font-medium text-muted-foreground">기타</div>
          {row("승인 방식", APPROVAL_MODE_LABEL[chat.approvalModeOverride ?? project.settings.approvalMode])}
          {row("목표", chat.goal ? `${chat.goal.objective} (${chat.goal.status})` : "없음")}
          {row("남은 사용량", (["claude", "codex", "grok", "deepseek"] as const).map(a => { const d = pickUsage(usage[a]); return `${AGENT_LABEL[a]} ${d ? `${d.window} ${Math.round(d.remaining)}%` : "정보 없음"}`; }).join(" · "))}
          {row("작업 폴더", <span className="font-mono text-[12px] break-all">{project.folder}</span>)}
        </div>
      </DialogContent>
    </Dialog>
  );
}
