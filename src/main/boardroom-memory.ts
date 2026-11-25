import { CHARACTER_PROVIDERS } from "../shared/character-meeting";
import type { AgentKind } from "../shared/types";

export const STRENGTHS = {
  research: "자료를 찾아 근거 연결", verification: "사실과 불확실성 구분", quantitative: "수치·시간 검산",
  planning: "실행 순서와 제약 정리", alternatives: "대안 비교", risks: "빠진 예외나 위험 발견",
} as const;

type Strength = keyof typeof STRENGTHS;
export type Credit = { turn: number; strength: Strength };
export type ModelIdentity = { agent: AgentKind; model: string };
type Record = ModelIdentity & { counts: Partial<{ [K in Strength]: number }>; updated: number };
type Settings = { getSetting(key: string): string | undefined; setSetting(key: string, value: string): void };
const SETTING = "boardroomModelStrengths";
const PROVIDERS: readonly AgentKind[] = Object.values(CHARACTER_PROVIDERS);
const isStrength = (value: unknown): value is Strength => typeof value === "string" && Object.hasOwn(STRENGTHS, value);
const isModel = (model: unknown): model is string => typeof model === "string" && /^[a-z0-9][a-z0-9._:/-]{0,159}$/i.test(model);

export function readCredits(value: unknown): Credit[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).filter((item): item is Credit => !!item && typeof item === "object"
    && Number.isInteger(item.turn) && item.turn > 0 && isStrength(item.strength));
}

export class BoardroomMemory {
  private readonly records: Record[];

  constructor(private readonly store: Settings) {
    this.records = this.load();
  }

  hints(agent: AgentKind, model: string) {
    const latest = this.records.filter(entry => entry.agent === agent && (!model || entry.model === model))
      .sort((a, b) => b.updated - a.updated)[0];
    if (!latest) return undefined;
    const strengths = Object.entries(latest.counts).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([key, observations]) => ({ strength: STRENGTHS[key as Strength], observations }));
    return { model: latest.model, strengths };
  }

  learn(credits: Credit[], models: ReadonlyMap<number, ModelIdentity>) {
    const seen = new Set<string>();
    for (const credit of credits) {
      const identity = models.get(credit.turn);
      const key = `${credit.turn}/${credit.strength}`;
      if (!identity || !isModel(identity.model) || seen.has(key)) continue;
      seen.add(key);
      let record = this.records.find(entry => entry.agent === identity.agent && entry.model === identity.model);
      if (!record) {
        record = { ...identity, counts: {}, updated: Date.now() };
        this.records.push(record);
      }
      record.updated = Date.now();
      record.counts[credit.strength] = Math.min(30, (record.counts[credit.strength] ?? 0) + 1);
    }
    if (!seen.size) return;
    this.records.sort((a, b) => b.updated - a.updated);
    this.records.splice(40);
    this.store.setSetting(SETTING, JSON.stringify(this.records));
  }

  private load(): Record[] {
    try {
      const value = JSON.parse(this.store.getSetting(SETTING) ?? "[]");
      if (!Array.isArray(value)) return [];
      const records: Record[] = [];
      for (const item of value.slice(0, 40)) {
        if (!item || !PROVIDERS.includes(item.agent) || !isModel(item.model) || !Number.isFinite(item.updated)) continue;
        const counts: Record["counts"] = {};
        for (const [key, count] of Object.entries(item.counts ?? {}))
          if (isStrength(key) && typeof count === "number" && Number.isInteger(count) && count > 0) counts[key] = Math.min(30, count);
        if (Object.keys(counts).length) records.push({ agent: item.agent, model: item.model, counts, updated: item.updated });
      }
      return records;
    } catch { return []; }
  }
}
