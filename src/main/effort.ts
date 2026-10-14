import type { ModelOption } from "../shared/types";

export const WORKER_EFFORTS = ["medium", "high", "xhigh"] as const;

/** Never raise an assignment above the master's choice or outside the model's advertised range. */
export function resolveEffort(requested: string, model: ModelOption): string {
  if (!requested) return "";
  const supported = model.reasoningEfforts ?? [];
  if (supported.includes(requested)) return requested;
  const index = WORKER_EFFORTS.indexOf(requested as typeof WORKER_EFFORTS[number]);
  if (index >= 0) {
    const fallback = WORKER_EFFORTS.slice(0, index + 1).findLast((level) => supported.includes(level));
    if (fallback) return fallback;
  }
  throw new Error(`${model.label}에서 추론 수준 ${requested}을 지원하지 않습니다. 모델 또는 추론 설정을 변경하세요.`);
}

export function workerEffort(setting: string, requested?: string): string {
  if (requested !== undefined && !(WORKER_EFFORTS as readonly string[]).includes(requested))
    throw new Error("작업자 effort는 medium, high, xhigh 중에서 선택하세요.");
  if (!setting || setting === "auto") {
    if (!requested) throw new Error("자동 배정에는 마스터가 effort(medium, high, xhigh)를 선택해야 합니다. reason에 선택 이유도 적으세요.");
    return requested;
  }
  if (setting && !(WORKER_EFFORTS as readonly string[]).includes(setting))
    throw new Error("작업자 추론 설정은 medium, high, xhigh 또는 마스터 자동만 지원합니다.");
  return setting;
}
