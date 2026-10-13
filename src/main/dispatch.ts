import type { ChatAgent, Consult } from "../shared/types";

/** Critical diagnoses need both families' actual reports before editing or completing. */
export function dualInvestigationIssue(id: number, all: Consult[], agents: Pick<ChatAgent, "key" | "kind">[]): string | null {
  const reports = all.filter((c) => c.instructionId === id && c.fromRole === "orch" && c.kind === "opinion" && c.status === "done" && c.responseSummary?.trim());
  const missing = (["claude", "gpt"] as const).filter((kind) => !reports.some((c) => agents.some((a) => a.key === c.toRole && a.kind === kind)));
  return missing.length ? `중요 오류의 양쪽 조사가 필요합니다: ${missing.map((k) => k === "claude" ? "클로드" : "지피티").join("·")}의 opinion 조사 결과가 없습니다. 같은 문제·자료를 독립적으로 조사시킨 뒤 두 결과의 공통점·차이·근거를 비교해 취합하세요. 사용 불가·한도·실패로 조사할 수 없으면 미완료 사유를 보고하세요.` : null;
}

/** Only persisted work for this instruction can satisfy its completion gate. */
export function completionIssue(id: number, mode: "direct" | "delegated" | undefined, all: Consult[], reviewGate: boolean): string | null {
  if (!mode) return "처리 방식이 기록되지 않았습니다. route_request로 기록하세요.";
  if (mode === "direct") return null;
  const work = all.filter((c) => c.instructionId === id);
  if (!work.length) return "실제로 배정된 작업이 없습니다. 앱 spawn/ask로 본 작업을 맡기세요.";
  if (work.some((c) => c.status === "running")) return "아직 응답이 돌아오지 않은 작업이 있습니다.";
  const resolved = new Set<number>();
  for (const done of work.filter((c) => c.status === "done" && c.responseSummary?.trim())) {
    let prev = done.supersedes;
    while (prev && !resolved.has(prev)) { resolved.add(prev); prev = work.find((c) => c.id === prev)?.supersedes; }
  }
  const missing = work.filter((c) => !resolved.has(c.id) && (c.status !== "done" || !c.responseSummary?.trim()));
  if (missing.length) return `미완료 협의 ${missing.map((c) => c.id).join(", ")}. 가능하면 ask의 supersedes에 협의 id를 넣어 보완·재배정하고, 불가능하면 미완료 사유를 보고하세요.`;
  if (reviewGate) {
    const changed = work.filter((c) => c.kind === "implement" && c.status === "done" && c.filesChanged.some((f) => /\.(?:[cm]?[jt]sx?|py|cs|java|go|rs|c|cpp|h|vue|svelte|sql)$/i.test(f)));
    if (changed.some((c) => !work.some((r) => r.kind === "review" && r.status === "done" && r.toRole !== c.toRole && r.seq > c.seq)))
      return "코드를 변경한 작업자와 다른 작업자의 교차 리뷰 결과가 필요합니다.";
  }
  return null;
}
