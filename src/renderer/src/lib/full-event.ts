// Originals of shortened history items, one request at a time: each can be tens of MB, and several
// cards opened together must not hold them all in flight.
import type { TimelineEvent } from "../../../shared/types";

let queue: Promise<unknown> = Promise.resolve();

/** Runs `load` after the previous original request finished (failed ones do not block the queue). */
export function oneAtATime<T>(load: () => Promise<T>): Promise<T> {
  const run = queue.then(load, load);
  queue = run.catch(() => undefined);
  return run;
}

export const loadFullEvent = (load: (chatId: number, eventId: number) => Promise<TimelineEvent | undefined>, chatId: number, eventId: number) =>
  oneAtATime(() => load(chatId, eventId));
