// Recovery note for a run the app quit or crashed in. Facts from the stored record only: nothing here
// restarts work, and the master decides what to continue.
import { CONSULT_KIND_LABEL, roleName, type ChatAgent, type ChatGoal, type Consult, type TimelineEvent } from "../shared/types";
import type { ConsultAssignment } from "./db";

const MAX_CONTEXT = 12_000;
const MAX_LIST = 15;

const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};
/** Result summaries start with an account line; it would use up the clip. */
const withoutRunHeader = (summary: string) => summary.replace(/^\[(?:CLI|Gemini 웹) [^\n]*\]\n/, "");
/** The app's own tools end with their assignment records; they are not workspace actions. */
const isAppTool = (name: string) => /chatterbox/i.test(name);

/** The instruction as it actually ran. Private (settings table): not sent to clients or copied by a fork. */
export interface InstructionSnapshot {
  id: number;
  text: string;
  mode?: "direct" | "delegated";
  dualInvestigation?: boolean;
  planning: boolean;
  reviewing: boolean;
  /** Id of the approved /plan being carried out; absent on older snapshots (never inferred). */
  planRun?: number;
}

export function parseInstructionSnapshot(raw: string | undefined): InstructionSnapshot | undefined {
  try {
    const s = JSON.parse(raw ?? "null");
    return s && Number.isSafeInteger(s.id) && typeof s.text === "string"
      ? { ...s, planning: !!s.planning, reviewing: !!s.reviewing, planRun: Number.isSafeInteger(s.planRun) ? s.planRun : undefined }
      : undefined;
  } catch { return undefined; }
}

/**
 * Which instruction a crashed run continues, or null when the record cannot say. Without a snapshot,
 * only a lone queued message can be matched to its dispatch: a batch or an already consumed message
 * leaves the text the run actually had unknown, and a guess must not become approval context.
 */
export function instructionToResume(events: readonly TimelineEvent[], saved: InstructionSnapshot | undefined): InstructionSnapshot | null {
  const direct = events.findLast(e => e.event.type === "user" && !e.event.queued);
  const directId = direct?.id ?? 0;
  // A newer direct message means the crash came before this snapshot was replaced.
  if (saved && saved.id >= directId) return saved;
  const dispatches = events.flatMap(e => e.event.type === "dispatch" ? [e.event] : []);
  const latest = dispatches.at(-1);
  let id = directId;
  let text = direct?.event.type === "user" ? direct.event.text : "";
  if (latest && latest.instructionId > directId) {
    id = latest.instructionId;
    const lower = Math.max(directId, ...dispatches.filter(d => d.instructionId < id).map(d => d.instructionId));
    const queued = events.filter(e => e.id > lower && e.id <= id && e.event.type === "user" && e.event.queued);
    const only = queued[0]?.event;
    if (queued.length !== 1 || queued[0].id !== id || only?.type !== "user") return null;
    text = only.text;
  }
  // A later "now" message may have been merged into the running text (or fallen back to the queue),
  // and the record does not say which. Records without the field predate it and were always queued.
  if (events.some(e => e.id > id && e.event.type === "user" && e.event.queued && e.event.delivery === "now")) return null;
  const recorded = dispatches.findLast(d => d.instructionId === id);
  // Slash commands are direct messages; a queued follow-up never inherits one.
  const command = id === directId ? text : "";
  return { id, text, mode: recorded?.mode, dualInvestigation: recorded?.dualInvestigation, planning: /^\/plan(?:\s|$)/.test(command), reviewing: /^\/review(?:\s|$)/.test(command) };
}

export interface ResumeInput {
  instructionId: number;
  /** The running instruction's text: follow-ups already merged into it are not listed again. */
  instructionText?: string;
  consults: Consult[];
  events: readonly TimelineEvent[];
  agents: ChatAgent[];
  assignment(consultId: number): ConsultAssignment | undefined;
  goal?: ChatGoal | null;
}

export interface ResumeContext {
  text: string;
  done: number;
  interrupted: number;
  unconfirmedTools: number;
  followUps: number;
}

function list<T>(items: T[], render: (item: T) => string, keep: "first" | "last" = "first"): string[] {
  const shown = keep === "first" ? items.slice(0, MAX_LIST) : items.slice(-MAX_LIST);
  return [...shown.map(render), ...(items.length > shown.length ? [`- …외 ${items.length - shown.length}건`] : [])];
}

function assignmentText(a: ConsultAssignment | undefined, c: Consult): string {
  const parts = [
    a?.model && `모델=${a.model}`,
    (c.effort || c.requestedEffort) && `추론=${c.effort || c.requestedEffort}`,
    (a?.accountId || a?.webAccountId) && `계정=${a.accountId ?? a.webAccountId}`,
    a?.attach.length && `첨부=${a.attach.join(", ")}`,
    a?.discussion && `토의=${clip(a.discussion.topic, 120)}(${a.discussion.peers.join(", ")})`,
  ].filter(Boolean);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

export function buildResumeContext(input: ResumeInput): ResumeContext {
  const { instructionId, instructionText, consults, events, agents, assignment, goal } = input;
  const name = (role: Consult["toRole"]) => roleName(role, agents);
  const own = consults.filter(c => c.instructionId === instructionId);
  const replaced = new Set(own.map(c => c.supersedes).filter((id): id is number => id !== undefined));
  const done = own.filter(c => c.status === "done");
  const interrupted = own.filter(c => c.status === "stopped" && c.interruptedBy === "app_exit" && !replaced.has(c.id));
  const failed = own.filter(c => (c.status === "error" || c.status === "limited") && !replaced.has(c.id));

  const anchorId = events.findLast(e => e.event.type === "user" && !e.event.queued)?.id ?? instructionId;
  // Messages up to the current instruction belong to it; delivered ones are already part of its text.
  const after = Math.max(anchorId, instructionId);
  const followUps = events.flatMap(e => e.id > after && e.event.type === "user" && e.event.queued && !instructionText?.includes(`[사용자 추가 지시]\n${e.event.text}`) ? [e.event] : []);

  // Same node, role and id: Codex re-emits a running call. A turn ending does not say whether a call
  // without a result ran, so it stays listed; only a result closes it.
  const open = new Map<string, Extract<TimelineEvent["event"], { type: "tool_call" }> & { role: TimelineEvent["role"]; turnEnded?: boolean }>();
  for (const e of events) {
    if (e.id < anchorId) continue;
    const scope = `${e.node}|${e.role}|`;
    if (e.event.type === "tool_call") {
      if (!isAppTool(e.event.name)) open.set(scope + e.event.id, { ...e.event, role: e.role });
    } else if (e.event.type === "tool_result" || e.event.type === "file_change") open.delete(scope + e.event.id);
    else if (e.event.type === "turn_end") for (const [key, call] of open) if (key.startsWith(scope)) call.turnEnded = true;
  }
  const tools = [...open.values()];

  // What needs a decision first, so the overall limit can only cut completed history.
  const sections: string[] = [];
  if (goal?.status === "active") sections.push(`현재 목표: ${clip(goal.objective, 600)}${goal.progress ? ` (최근 진행: ${clip(goal.progress, 300)})` : ""}`);
  if (interrupted.length) sections.push(["앱 종료로 끊긴 협의 — 필요한 것만 ask의 supersedes=협의 id로 이어 맡기세요:", ...list(interrupted, c =>
    `- 협의 ${c.id} · ${name(c.toRole)} · ${CONSULT_KIND_LABEL[c.kind]}${c.scope.length ? ` · 범위=${c.scope.join(", ")}` : ""}${assignmentText(assignment(c.id), c)}\n  요청: ${clip(c.request, 500)}`)].join("\n"));
  if (tools.length) sections.push(["결과를 받지 못한 도구 호출 — 실행 여부를 알 수 없으니 결과를 확인하기 전에 반복하지 마세요:", ...list(tools, t =>
    `- ${t.role ? roleName(t.role, agents) : "마스터"} · ${t.name}: ${clip(t.input, 200)}${t.turnEnded ? " (턴 종료까지 결과 없음)" : ""}`, "last")].join("\n"));
  if (followUps.length) sections.push(["중단 전에 도착한 사용자 추가 지시 — 이미 반영했으면 반복하지 마세요:", ...list(followUps, f =>
    `- ${clip(f.text, 500)}${f.attachments?.length ? ` · 첨부: ${f.attachments.map(a => a.path).join(", ")}` : ""}`, "last")].join("\n"));
  if (failed.length) sections.push(["실패한 협의:", ...list(failed, c => `- 협의 ${c.id} · ${name(c.toRole)} · ${c.status}: ${clip(withoutRunHeader(c.responseSummary ?? ""), 300)}`)].join("\n"));
  if (done.length) sections.push(["완료된 협의 — 다시 맡기지 마세요:", ...list(done, c =>
    `- 협의 ${c.id} · ${name(c.toRole)} · ${CONSULT_KIND_LABEL[c.kind]}${c.review ? ` · 판정=${c.review.verdict}` : ""}: ${clip(withoutRunHeader(c.responseSummary ?? ""), 400) || "(요약 없음)"}${c.filesChanged.length ? ` · 변경: ${clip(c.filesChanged.join(", "), 300)}` : ""}`)].join("\n"));

  const counts = { done: done.length, interrupted: interrupted.length, unconfirmedTools: tools.length, followUps: followUps.length };
  if (!sections.length) return { text: "", ...counts };
  const body = `[복구 정보 — 저장된 기록 기준이며 앱이 자동으로 다시 실행한 일은 없습니다. 완료 ${counts.done} · 중단 ${counts.interrupted} · 결과 미확인 도구 ${counts.unconfirmedTools} · 추가 지시 ${counts.followUps}]\n${sections.join("\n\n")}`;
  return { text: body.length > MAX_CONTEXT ? `${body.slice(0, MAX_CONTEXT)}\n…(복구 정보가 길어 이하 생략)` : body, ...counts };
}
