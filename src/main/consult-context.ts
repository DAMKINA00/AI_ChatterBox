import { CONSULT_KIND_LABEL, type Consult } from "../shared/types";

/** Model context only. The complete report, review and artifact list stay in the store/UI. */
export function consultResultText(c: Consult): string {
  const text = c.responseSummary ?? "(아직 결과 없음)";
  const excerpt = text.length > 1200;
  const summary = excerpt ? `${text.slice(0, 800)}\n…[중간 내용 생략 — 전체 결과는 read_consult로 확인]\n${text.slice(-400)}` : text;
  const review = c.kind !== "review" ? "" : c.review
    ? `\n구조화 리뷰: ${c.review.verdict} · 기준 ${c.review.revision.slice(0, 160)} · 지적 ${c.review.findings.length}건 (high ${c.review.findings.filter(f => f.severity === "high").length}) · 테스트 실패 ${c.review.tests.filter(t => t.status === "failed").length}건 · 미실행 ${c.review.tests.filter(t => t.status === "not_run").length}건\n${c.review.summary.slice(0, 400)}`
    : "\n구조화 리뷰 결과가 제출되지 않았습니다. 통과로 간주하지 마세요.";
  const files = c.filesChanged.slice(0, 12);
  return `협의 id=${c.id} · ${CONSULT_KIND_LABEL[c.kind]} · 상태=${c.status}\n${summary}${review}\n변경된 파일: ${c.filesChanged.length ? files.join("\n") : "없음"}${c.filesChanged.length > files.length ? `\n…외 ${c.filesChanged.length - files.length}개` : ""}\n상세: read_consult(consultId=${c.id}, detail=true)${excerpt ? " — 발췌만으로 완료·검증을 판단하지 말고 필요한 근거를 조회하세요." : ""}`;
}

export function consultStatusText(c: Consult): string {
  return `협의 id=${c.id} · ${c.request?.startsWith("[작업자 결과 취합]") ? "취합" : CONSULT_KIND_LABEL[c.kind]} · ${c.status} · 파일 ${c.filesChanged.length}개${c.kind === "review" ? ` · 리뷰=${c.review?.verdict ?? "미제출"}` : ""}`;
}

/** Final decision brief for the master, after workers have collected the underlying evidence. */
export function masterResultText(c: Consult, report = c.responseSummary ?? ""): string {
  // Account diagnostics remain in the saved report; they aren't part of the worker's conclusion.
  const body = report.replace(/^(?:\[(?:CLI |우선 할당:)[^\n]*\]\r?\n)+/, "").trim();
  const brief = body.length > 400 ? `${body.slice(0, 260)}\n…[발췌]\n${body.slice(-140)}` : body;
  const review = c.kind !== "review" ? "" : c.review
    ? `\n리뷰 ${c.review.verdict} · 지적 ${c.review.findings.length} · 실패 검사 ${c.review.tests.filter(t => t.status === "failed").length} · 미실행 ${c.review.tests.filter(t => t.status === "not_run").length}`
    : "\n리뷰 미제출: 통과로 간주하지 마세요.";
  return `${consultStatusText(c)}\n${brief}${review}${c.filesChanged.length ? `\n산출물: ${c.filesChanged.slice(0, 3).join(" · ")}${c.filesChanged.length > 3 ? ` (외 ${c.filesChanged.length - 3}개)` : ""}` : ""}`;
}
