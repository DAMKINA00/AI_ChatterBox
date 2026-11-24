// Plan mode toggle rules shared by the desktop and remote composers. Pure, so they can be unit-tested.
import type { TimelineEvent } from "../../../shared/types";
import { pendingAskId } from "./plan-view";

/** Alt+P (by physical key, so it works with the Korean layout), without other modifiers and not auto-repeated. */
export function isPlanHotkey(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code: string; repeat: boolean }): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.repeat && e.code === "KeyP";
}

/**
 * A toggle request is in flight (`target` is the value asked for) until the chat the app shows carries
 * that value. Sending meanwhile could reach the main process before the toggle and run a plan request as
 * ordinary work, so sends wait until this returns true.
 */
export const planToggleSettled = (target: boolean | null, current: boolean) => target === null || target === current;

/** Longest wait for the chat update after a successful toggle before sends are allowed again. */
export const PLAN_TOGGLE_SETTLE_MS = 4000;

const LIVE = new Set(["working", "approval"]);

/**
 * The master's unanswered question to point at from the plan UI: only during a live turn, and only while
 * plan mode is on or a plan is shown (a plan-mode turn asks before any proposal exists).
 */
export function planAskId(events: readonly TimelineEvent[], status: string, planMode: boolean, hasPlan: boolean): string | undefined {
  return LIVE.has(status) && (planMode || hasPlan) ? pendingAskId(events) : undefined;
}
