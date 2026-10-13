// Who-waits-on-whom bookkeeping for asks between the master and workers (deadlock / depth guard).

export type WaitGraph = Map<string, Set<string>>;

/** Is `from` (transitively) waiting on `to`? */
export function waitsOn(g: WaitGraph, from: string, to: string, seen = new Set<string>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  for (const t of g.get(from) ?? []) if (waitsOn(g, t, to, seen)) return true;
  return false;
}

/** Depth of a role in the wait chain: master ("orch") 0, a worker the master asked 1, … */
export function depthOf(g: WaitGraph, role: string, seen = new Set<string>()): number {
  if (role === "orch" || seen.has(role)) return 0;
  seen.add(role);
  let d = 0;
  for (const [caller, targets] of g) if (targets.has(role)) d = Math.max(d, 1 + depthOf(g, caller, new Set(seen)));
  return d;
}

export type AskRefusal = "self" | "cycle" | "depth" | null;

/** Can `caller` ask `target` right now? */
export function checkAsk(g: WaitGraph, caller: string, target: string, maxDepth: number): AskRefusal {
  if (caller === target) return "self";
  if (waitsOn(g, target, caller)) return "cycle";
  if (depthOf(g, caller) + 1 > maxDepth) return "depth";
  return null;
}

export function addWait(g: WaitGraph, caller: string, target: string) {
  const s = g.get(caller) ?? new Set<string>();
  s.add(target);
  g.set(caller, s);
}

export function removeWait(g: WaitGraph, caller: string, target: string) {
  g.get(caller)?.delete(target);
}
