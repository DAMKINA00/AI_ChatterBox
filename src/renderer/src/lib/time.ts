import type { TimelineEvent } from "../../../shared/types";

/** The start of the latest persisted instruction that is not queued for later. */
export function latestInstructionAt(events: readonly TimelineEvent[], fallback: number): number {
  let latest: number | undefined;
  for (const event of events) {
    if (event.event.type !== "user" || event.event.queued) continue;
    if (latest === undefined || event.at > latest) latest = event.at;
  }
  return latest ?? fallback;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}시간 ${minutes}분 ${seconds}초` : `${minutes}분 ${seconds}초`;
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
