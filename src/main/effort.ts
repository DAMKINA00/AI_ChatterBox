import type { ModelOption } from "../shared/types";

export const WORKER_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

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
  if (requested !== undefined && (typeof requested !== "string" || !requested.trim()))
    throw new Error("작업자 effort는 모델이 지원하는 추론 수준 중에서 선택하세요.");
  if (!setting || setting === "auto") {
    return requested ?? "";
  }
  return setting;
}
