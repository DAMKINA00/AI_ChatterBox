import type { ChatStatus, Consult, Role, TimelineEvent } from "../../../shared/types";

export const WORKER_ACCEPTANCE = "요청을 받았어요. 작업을 시작합니다.";

export function pendingWorkerApprovals(events: readonly TimelineEvent[]): Set<Role> {
  const pending = new Map<string, Role>();
  for (const { event } of events) {
    if (event.type === "approval_request") pending.set(event.request.id, event.request.role);
    else if (event.type === "approval_resolved") pending.delete(event.id);
  }
  return new Set(pending.values());
}

export function runningAssignments(status: ChatStatus, consults: readonly Consult[] | undefined, waiting: ReadonlySet<Role>) {
  const running = new Map<Role, Consult>();
  if (status !== "working" && status !== "approval") return running;
  for (const consult of consults ?? []) {
    if (consult.status !== "running" || waiting.has(consult.toRole)) continue;
    const previous = running.get(consult.toRole);
    if (!previous || consult.startedAt >= previous.startedAt) running.set(consult.toRole, consult);
  }
  return running;
}

export type WorkerActivity = { at: number; label: string; detail?: string; output?: string };

/** Latest visible provider activity for this assignment. Never infer model reasoning from silence. */
export function workerActivity(events: readonly TimelineEvent[], consult: Consult): WorkerActivity | undefined {
  const node = `consult:${consult.id}`;
  const calls = new Map<string, { name: string; input: string }>();
  let latest: WorkerActivity | undefined;
  for (const { node: eventNode, role, event, at } of events) {
    if (eventNode !== node || role !== consult.toRole) continue;
    switch (event.type) {
      case "turn_end":
        calls.clear();
        latest = undefined;
        break;
      case "tool_call":
        if (internalTool(event.name)) break;
        calls.set(event.id, event);
        latest = { at, label: `${event.name} 실행 중`, detail: firstLine(event.input) };
        break;
      case "tool_progress": {
        const call = calls.get(event.id);
        const name = call?.name ?? event.name;
        if (!name || internalTool(name)) break;
        const elapsed = event.elapsedSeconds === undefined ? "" : ` · ${event.elapsedSeconds.toLocaleString("ko-KR")}초 경과`;
        latest = { at, label: `${name} ${call || elapsed ? "실행 중" : "준비 중"}${elapsed}`, detail: firstLine(call?.input), output: tail(event.delta) };
        break;
      }
      case "tool_result": {
        const call = calls.get(event.id);
        if (!call) break;
        calls.delete(event.id);
        latest = { at, label: `${call.name} ${event.ok ? "완료" : "실패"}`, detail: firstLine(call.input), output: tail(event.output) };
        break;
      }
      case "file_change":
        latest = { at, label: event.ok ? "파일 변경 적용" : "파일 변경 실패", detail: event.files.map(file => file.path).join(", ").slice(0, 280) };
        break;
      case "text_delta":
      case "text":
        latest = { at, label: event.type === "text_delta" ? "답변 작성 중" : "응답 수신" };
        break;
    }
  }
  return latest;
}

function internalTool(name: string) {
  return name.includes("chatterbox_bridge") || name === "set_expression" || name === "TodoWrite";
}

function firstLine(text?: string) {
  return text?.split("\n").map(line => line.trim()).find(line => line && line !== "{")?.slice(0, 280);
}

function tail(text?: string) {
  return text?.slice(-1200).replace(/\u001b\[[\x20-\x3f]*[\x40-\x7e]/g, "").trim().split(/\r?\n/).slice(-3).join("\n");
}
