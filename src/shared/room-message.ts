// Display provenance of group chat lines. Only the screen uses this: stored text and team delivery never change.
import { CONSULT_KIND_LABEL, type AgentEvent, type ConsultStatus, type Role, type RoomMessageKind } from "./types";

type Room = Extract<AgentEvent, { type: "room_message" }>;

/** What the timeline already knows about a consult when a group line arrives. */
export interface ConsultFacts {
  target(id: number): Role | undefined;
  ended(id: number): { status: ConsultStatus; summary: string } | undefined;
}

/** The orchestrator's copy of a summary in the group wrapper: whitespace collapsed, clipped to 4000 characters. */
function wrapperBody(summary: string): string {
  const t = summary.replace(/\s+/g, " ").trim();
  return t.length > 4000 ? t.slice(0, 4000) + "…" : t;
}

export interface RoomProvenance {
  kind: RoomMessageKind;
  consultId?: number;
  status?: ConsultStatus;
}

// The exact wrapper the app wrote before kind existed: "[구현 · done · 협의 12 · model]\n<summary>".
const LEGACY_RESULT = new RegExp(`^\\[(?:${Object.values(CONSULT_KIND_LABEL).join("|")}) · (done|error|stopped|limited) · 협의 (\\d+)(?: · [^\\]\\n]*)?\\]\\n`);
// The app's long-run check, which used to be stored under the quiet worker's name.
const LEGACY_SYSTEM = /^\[앱 상태 점검\] .+의 활동이 \d+분간 없습니다\./;

/**
 * Explicit kind wins (only the app sets it). Without it, a line is a real message unless it is exactly an app
 * wrapper: a consult result must match the consult's target, its recorded end status, and its body must be the
 * exact copy of that consult's recorded summary. A correction or anything else written after the same header
 * stays a real message: when unsure, keep it.
 */
export function roomProvenance(ev: Room, facts?: ConsultFacts): RoomProvenance {
  if (ev.kind) return { kind: ev.kind, consultId: ev.consultId, status: ev.status };
  const result = LEGACY_RESULT.exec(ev.text);
  if (result && facts) {
    const consultId = Number(result[2]);
    const status = result[1] as ConsultStatus;
    const ended = facts.ended(consultId);
    const body = ev.text.slice(result[0].length);
    if (facts.target(consultId) === ev.from && ended?.status === status && body === wrapperBody(ended.summary)) return { kind: "result", consultId, status };
  }
  if (ev.from !== "orch" && LEGACY_SYSTEM.test(ev.text)) return { kind: "system" };
  return { kind: "chat" };
}

/** One line for an app status check: who is quiet and that it is not a failure. The full note stays expandable. */
export function systemBrief(text: string): string {
  const body = text.replace(/^\[앱 상태 점검\]\s*/, "");
  const first = /^[^\n]*?\./.exec(body)?.[0] ?? body.split("\n")[0];
  return `앱 상태 점검 · ${first.trim()} 실패로 단정하지 않습니다.`;
}

// Account/run metadata lines the app puts at the top of a consult summary.
const ACCOUNT_LINE = /^\[(?:CLI|Gemini 웹) 지정 계정=/;

/** The first line that explains a failed/stopped/limited consult, without account metadata. */
export function consultReason(summary: string | undefined, max = 200): string | undefined {
  const line = summary?.split("\n").map((l) => l.trim()).find((l) => l && !ACCOUNT_LINE.test(l));
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
