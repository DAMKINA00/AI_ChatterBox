// User conversation fork: which messages offer it and how the origin is described. Pure: desktop and remote UI.
import type { Chat, ChatForkOptions } from "../../../shared/types";
import type { Item } from "../timeline";

export const FORK_NOTE = "대화만 분기되며 작업 폴더는 공유됩니다. 파일 복원이나 Git 브랜치·worktree를 만들지 않습니다.";
export const FORK_NOT_COPIED = "작업자·실행 중 작업·대기 승인·허용 기록·목표·CLI 세션은 복제되지 않고, 새 채팅은 대기 상태로 시작합니다. 원본 채팅은 바뀌지 않습니다.";
export const FORK_RANGE_LABEL: Record<ChatForkOptions["range"], string> = { through: "처음부터 이 메시지까지", from: "이 메시지부터 끝까지" };

/**
 * Persisted event id of a message between the user and the master. Worker messages, group messages,
 * tool/approval/consult cards and streams are not fork points.
 */
export function forkEventId(item: Item): number | undefined {
  if (item.kind === "user") return item.eventId;
  if (item.kind === "message" && !item.streaming && item.role === "orch") return item.eventId;
  return undefined;
}

export function defaultForkOptions(eventId: number): ChatForkOptions {
  return { eventId, range: "through", includeAttachments: false };
}

/** "‘원본 제목’ #123 메시지까지 분기 · 첨부 제외" */
export function forkOriginText(fork: NonNullable<Chat["fork"]>): string {
  return `‘${fork.sourceTitle}’(채팅 ${fork.sourceChatId})의 메시지 #${fork.sourceEventId}${fork.range === "through" ? "까지" : "부터"} 분기 · 첨부 ${fork.includeAttachments ? "포함" : "제외"}`;
}

/** Collapsed preview line of a snapshot. */
export function forkPreview(text: string, max = 120): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
