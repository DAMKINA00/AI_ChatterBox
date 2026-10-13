// Model pickers show only the newest model of each family. Families and "newest" come from the ids the
// CLIs report (no hardcoded model names): Claude aliases (opus / sonnet / haiku / fable…) already point
// at the newest version, so pinned "claude-<family>-<version>" ids are older; Codex ids look like
// "gpt-<version>-<family>". Whatever the project/chat has selected stays visible (marked old).
import type { AgentKind, ModelOption } from "./types";

export interface PickerModel extends ModelOption {
  /** Shown only because it is selected; a newer model of its family exists. */
  old?: boolean;
}

function claudeFamily(id: string): { family: string; version: number[] } | null {
  const m = /^claude-([a-z]+)-([\d-]+?)(?:-(\d{8}))?(\[.*\])?$/.exec(id);
  if (!m) return null;
  return { family: m[1] + (m[4] ?? ""), version: m[2].split("-").map(Number) };
}

function codexFamily(id: string): { family: string; version: number[] } | null {
  const m = /^gpt-(\d+(?:\.\d+)*)-?(.*)$/.exec(id);
  if (!m) return null;
  return { family: m[2] || "gpt", version: m[1].split(".").map(Number) };
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export function latestModels(agent: AgentKind, list: ModelOption[], selected: string[] = []): PickerModel[] {
  const keep = new Set<string>();
  const usable = list.filter((m) => !m.hidden && !m.deprecated);
  const familyOf = agent === "claude" ? claudeFamily : codexFamily;
  // Claude aliases (no version in the id) stand for the newest model of their family.
  const aliasFamilies = new Set(agent === "claude" ? usable.filter((m) => !familyOf(m.id)).map((m) => m.id) : []);
  const best = new Map<string, { id: string; version: number[] }>();
  for (const m of usable) {
    const f = familyOf(m.id);
    if (!f) {
      keep.add(m.id); // alias or unversioned id
      continue;
    }
    if (aliasFamilies.has(f.family)) continue; // the alias covers it
    const cur = best.get(f.family);
    if (!cur || newer(f.version, cur.version)) best.set(f.family, { id: m.id, version: f.version });
  }
  for (const b of best.values()) keep.add(b.id);
  for (const m of usable) if (m.isDefault) keep.add(m.id);

  const out: PickerModel[] = list.filter((m) => keep.has(m.id));
  for (const id of selected) {
    if (!id || keep.has(id)) continue;
    const known = list.find((m) => m.id === id);
    out.push({ ...(known ?? { id, label: id }), old: true });
  }
  return out;
}
