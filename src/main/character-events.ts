import { CONSULT_KIND_LABEL as KIND_LABEL, type ChatAgent, type Consult, type ConsultKind, type ConsultStatus } from "../shared/types";
import type { ChatNotice } from "./chat-notifications";
import type { MonitorCharacterId } from "../shared/usage-companion";

/**
 * Character events for the usage monitor: the master (Orch) announces each assignment it makes, the worker
 * that ran it reports the outcome, and the chat-level approval / error / done notices go to Orch. Only live
 * events are produced (nothing that started or ended before this feed existed), each exactly once.
 * The text is a short, sanitized line: never raw logs, responses, paths, URLs or secrets.
 */
export type CharacterEventKind = "assign" | "result" | "approval" | "error" | "done";

export interface CharacterEvent {
  id: string;
  character: MonitorCharacterId;
  kind: CharacterEventKind;
  ok?: boolean;
  text: string;
  chatId: number;
  consultId?: number;
}

const MAX_TEXT = 120;
const MAX_SUMMARY = 60;
const MAX_SEEN = 2000;

const WORKER_CHARACTER: Record<ChatAgent["kind"], MonitorCharacterId> = { claude: "claude", gpt: "gpt", gemini: "gemini", grok: "grok", deepseek: "deepseek" };

export const MONITOR_QUESTION_REASON = "사용량 모니터에서 보낸 사용자 질문";

/** A short user-facing excerpt. Skip account metadata and log/code blocks before removing sensitive values. */
export function summarize(text: string, max = MAX_SUMMARY): string {
  let fenced = false;
  let brief = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced || !line || /^(?:#{1,6}\s|\[(?:CLI|우선 할당)[^\]]*\]\s*$|\d{4}-\d\d-\d\d[T ]\d\d:|at\s+\S+\s*\(|PS\s+[A-Z]:)/i.test(line)) continue;
    const safe = line
      .replace(/\[[^\]]*(?:계정|account|\bCLI\b|우선 할당)[^\]]*\]/gi, " ")
      .replace(/(?:\b(?:authorization|api[-_ ]?key|password|passwd|secret|token|cookie)|비밀번호|비밀값|(?:접근 |인증 )?토큰|api\s*키|세션\s*키|쿠키)\s*[:=]\s*(?:"[^"]*"|'[^']*'|(?:(?:bearer|basic|token)\s+)?[^\s,;]+)/gi, "[비공개]")
      .replace(/\bbearer\s+[^\s,;]+/gi, "[비공개]")
      .replace(/\b(?:[a-z][a-z0-9+.-]{1,12}:\/\/|www\.)[^\s<>]+/gi, "[링크]")
      .replace(/(?:[A-Z]:[\\/]|\\\\)[^\r\n,*|;"'`<>]+/gi, "[경로]")
      .replace(/(?:~|\.{1,2})?\/[\p{L}\d_.-]+(?:\/[\p{L}\d_.-]+)*|\b[\w.-]+(?:\\[\w.-]+)+/gu, "[경로]")
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[메일]")
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[주소]")
      .replace(/\b(?:sk|pk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{8,}\b|\b[A-Za-z0-9_-]{32,}\b/g, "[비공개]")
      .replace(/^[\s>*+-]+|[`*_#>]/g, "")
      .replace(/\s+/g, " ").trim();
    if (!safe.replace(/\[(?:경로|링크|비공개|메일|주소)\]/g, "").match(/[\p{L}\d]/u)) continue;
    if (/^(?:요약|결론|결과|검증|완료(?:했습니다)?|승인(?:합니다)?|반영했습니다|summary|results?|done)[.\s]*$/i.test(safe)) {
      brief ||= safe;
      continue;
    }
    if (safe.length <= max) return safe;
    return safe.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
  }
  return brief;
}

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

function resultText(kind: ConsultKind, status: ConsultStatus): { ok: boolean; text: string } {
  const label = KIND_LABEL[kind];
  switch (status) {
    case "done": return { ok: true, text: `${label} 작업 결과를 보고했어요.` };
    case "limited": return { ok: false, text: `${label} 작업 중 사용 한도에 걸렸어요.` };
    case "stopped": return { ok: false, text: `${label} 작업이 중지됐어요.` };
    default: return { ok: false, text: `${label} 작업에 실패했어요.` };
  }
}

const NOTICE_TEXT: Partial<Record<ChatNotice, string>> = {
  approval: "승인이나 답변이 필요해요.",
  error: "작업 중 오류가 났어요.",
  done: "전체 작업을 마쳤어요.",
};

export class CharacterEventFeed {
  private readonly since: number;
  private readonly agents = new Map<number, ChatAgent[]>();
  private readonly seen = new Set<string>();

  constructor(private readonly send: (event: CharacterEvent) => void, private readonly now: () => number = Date.now) {
    this.since = now();
  }

  hasAgents(chatId: number) {
    return this.agents.has(chatId);
  }

  agentsUpdated(chatId: number, list: ChatAgent[]) {
    this.agents.set(chatId, list);
  }

  consultUpdated(c: Consult) {
    const worker = this.agents.get(c.chatId)?.find(a => a.key === c.toRole);
    if (!worker || c.reason === MONITOR_QUESTION_REASON) return; // Direct questions get a correlated reply instead.
    if (c.fromRole === "orch" && c.startedAt >= this.since) {
      const summary = summarize(c.request);
      const nickname = summarize(worker.nickname, 32) || "작업자";
      this.emit({
        id: `assign:${c.id}`, character: "orch", kind: "assign", chatId: c.chatId, consultId: c.id,
        text: clip(`${nickname}에게 ${KIND_LABEL[c.kind]} 작업을 맡겼어요${summary ? `: ${summary}` : "."}`),
      });
    }
    if (c.status !== "running" && c.endedAt !== null && c.endedAt >= this.since) {
      const { ok, text } = resultText(c.kind, c.status);
      const summary = summarize(c.responseSummary ?? "", 88);
      this.emit({ id: `result:${c.id}`, character: WORKER_CHARACTER[worker.kind], kind: "result", ok, chatId: c.chatId, consultId: c.id, text: clip(summary ? `${text} ${summary}` : text) });
    }
  }

  /** Chat-level notices (already one per transition from ChatNotifications); "reminder" is not a new event. */
  notice(chatId: number, notice: ChatNotice, at: number) {
    const text = NOTICE_TEXT[notice];
    if (!text || at < this.since) return;
    this.emit({ id: `${notice}:${chatId}:${at}`, character: "orch", kind: notice as CharacterEventKind, chatId, text });
  }

  private emit(event: CharacterEvent) {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value as string);
    this.send(event);
  }
}
