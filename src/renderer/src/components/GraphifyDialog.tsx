import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ban, CircleAlert, Clock3, Code2, ExternalLink, FileCode2, Hammer, Info, Loader2, Network, RefreshCw, Search, Sparkles } from "lucide-react";
import type { GraphifyAction, GraphifyGraph, GraphifyNode, GraphifyResponse, GraphifyStatus } from "../../../shared/graphify";
import { GRAPHIFY_VERSION } from "../../../shared/graphify";
import type { Project } from "../../../shared/types";
import { api, errorMessage } from "../lib/utils";
import { GraphifyCanvas, graphCommunityColor, selectVisibleNodes } from "./GraphifyCanvas";
import { Badge, Button, Dialog, DialogContent, Input } from "./ui";

const POLL_INTERVAL_MS = 1200;
const NODE_LIST_LIMIT = 80;
const PATH_TARGET_LIMIT = 80;

interface GraphifyDialogProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function actionLabel(action: GraphifyAction | undefined): string {
  if (action === "install") return "설치 중";
  if (action === "build") return "그래프 생성 중";
  if (action === "cancel") return "중지 중";
  if (action === "graph") return "그래프 불러오는 중";
  if (action === "query") return "검색 중";
  if (action === "explain") return "설명 가져오는 중";
  if (action === "path") return "경로 찾는 중";
  if (action === "open-source") return "파일 위치 여는 중";
  return "처리 중";
}

function ageText(timestamp?: number): string {
  if (!timestamp) return "생성 기록 없음";
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const elapsed = Math.max(0, Date.now() - milliseconds);
  if (elapsed < 60_000) return "방금 생성됨";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}분 전 생성됨`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}시간 전 생성됨`;
  return `${Math.floor(elapsed / 86_400_000)}일 전 생성됨`;
}

function sourceLocation(node: GraphifyNode): string {
  return `${node.sourceFile}${node.line ? `:${node.line}` : ""}`;
}

function confidenceLabel(value: string): "EXTRACTED" | "INFERRED" | "AMBIGUOUS" | "UNKNOWN" {
  const normalized = value.trim().toUpperCase();
  if (normalized === "EXTRACTED" || normalized === "INFERRED" || normalized === "AMBIGUOUS") return normalized;
  return "UNKNOWN";
}

function matchesNode(node: GraphifyNode, query: string, community: string): boolean {
  if (community !== "all" && node.community !== community) return false;
  if (!query.trim()) return true;
  const needle = query.trim().toLocaleLowerCase();
  return `${node.label} ${node.sourceFile} ${node.kind} ${node.description}`.toLocaleLowerCase().includes(needle);
}

function StatusSummary({ status, graph }: { status?: GraphifyStatus; graph?: GraphifyGraph }) {
  if (!status) return null;
  const generatedAt = graph?.generatedAt ?? status.generatedAt;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" data-testid="graphify-summary">
      <span className="inline-flex items-center gap-1"><Network className="size-3.5" />노드 {status.nodeCount.toLocaleString("ko-KR")}</span>
      <span>연결 {status.edgeCount.toLocaleString("ko-KR")}</span>
      <span className="inline-flex items-center gap-1"><Clock3 className="size-3.5" />{ageText(generatedAt)}</span>
      {status.stale && <span className="inline-flex items-center gap-1 text-warning"><CircleAlert className="size-3.5" />생성 후 시간이 지났습니다</span>}
    </div>
  );
}

function ActionResult({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <section className="grid gap-1.5 rounded-lg border border-primary/30 bg-primary/5 p-3 text-[12px]" aria-live="polite" data-testid="graphify-result">
      <div className="flex items-center gap-2 font-medium"><Sparkles className="size-4 text-primary" />분석 결과</div>
      <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">{text}</p>
    </section>
  );
}

export function GraphifyDialog({ project, open, onOpenChange }: GraphifyDialogProps) {
  const [status, setStatus] = useState<GraphifyStatus>();
  const [graph, setGraph] = useState<GraphifyGraph>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState("");
  const [community, setCommunity] = useState("all");
  const [query, setQuery] = useState("");
  const [resultText, setResultText] = useState<string>();
  const [pending, setPending] = useState<GraphifyAction>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const requestSeq = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pollInFlight = useRef(false);
  const previousBusy = useRef(false);
  const pendingAction = useRef<GraphifyAction | undefined>(undefined);

  const clearPoll = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = undefined;
  }, []);

  const loadGraph = useCallback(async (seq: number) => {
    if (seq !== requestSeq.current || !open) return;
    try {
      const response = await api.graphify({ projectId: project.id, action: "graph" });
      if (seq !== requestSeq.current || !open) return;
      setError(undefined);
      if (response.graph) {
        setGraph(response.graph);
        setStatus(response.status);
        setSelectedNodeId((current) => current && response.graph?.nodes.some((node) => node.id === current) ? current : undefined);
      } else {
        setStatus(response.status);
      }
    } catch (caught) {
      if (seq === requestSeq.current && open) setError(`그래프를 불러오지 못했습니다: ${errorMessage(caught)}`);
    }
  }, [open, project.id]);

  const refreshStatus = useCallback(async (seq: number) => {
    if (seq !== requestSeq.current || !open || pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const response = await api.graphify({ projectId: project.id, action: "status" });
      if (seq !== requestSeq.current || !open) return;
      const wasBusy = previousBusy.current;
      previousBusy.current = response.status.busy;
      setError(undefined);
      setStatus(response.status);
      if (wasBusy && !response.status.busy) void loadGraph(seq);
      if (response.status.busy) {
        clearPoll();
        pollTimer.current = setTimeout(() => void refreshStatus(seq), POLL_INTERVAL_MS);
      }
    } catch (caught) {
      if (seq === requestSeq.current && open) {
        setError(`Graphify 상태를 확인하지 못했습니다: ${errorMessage(caught)}`);
        clearPoll();
        if (previousBusy.current) pollTimer.current = setTimeout(() => void refreshStatus(seq), POLL_INTERVAL_MS);
      }
    } finally {
      pollInFlight.current = false;
    }
  }, [clearPoll, loadGraph, open, project.id]);

  const run = useCallback(async (action: GraphifyAction, fields?: { query?: string; node?: string; to?: string }) => {
    if (pending || pendingAction.current || !open) return;
    const seq = requestSeq.current;
    pendingAction.current = action;
    clearPoll();
    setPending(action);
    setError(undefined);
    if (["query", "explain", "path"].includes(action)) setResultText(undefined);
    try {
      const response: GraphifyResponse = await api.graphify({ projectId: project.id, action, ...fields });
      if (seq !== requestSeq.current || !open) return;
      const wasBusy = previousBusy.current;
      setStatus(response.status);
      if (response.graph) {
        setGraph(response.graph);
        setSelectedNodeId((current) => current && response.graph?.nodes.some((node) => node.id === current) ? current : undefined);
      }
      if (response.result) {
        setResultText(response.result.text);
        setHighlightedNodeIds(new Set(response.result.nodeIds));
      }
      previousBusy.current = response.status.busy;
      if (wasBusy && !response.status.busy) void loadGraph(seq);
      if (response.status.busy) {
        clearPoll();
        pollTimer.current = setTimeout(() => void refreshStatus(seq), POLL_INTERVAL_MS);
      }
    } catch (caught) {
      if (seq === requestSeq.current && open) {
        setError(`${actionLabel(action)} 실패: ${errorMessage(caught)}`);
        if (previousBusy.current) pollTimer.current = setTimeout(() => void refreshStatus(seq), POLL_INTERVAL_MS);
      }
    } finally {
      if (seq === requestSeq.current && open) {
        pendingAction.current = undefined;
        setPending(undefined);
      }
    }
  }, [clearPoll, loadGraph, open, pending, project.id, refreshStatus]);

  useEffect(() => {
    if (!open) return;
    const seq = ++requestSeq.current;
    clearPoll();
    pollInFlight.current = false;
    previousBusy.current = false;
    setStatus(undefined);
    setGraph(undefined);
    setSelectedNodeId(undefined);
    setHighlightedNodeIds(new Set());
    setResultText(undefined);
    setError(undefined);
    setPending(undefined);
    pendingAction.current = undefined;
    setSearch("");
    setCommunity("all");
    setQuery("");
    setLoading(true);
    void (async () => {
      try {
        const response = await api.graphify({ projectId: project.id, action: "status" });
        if (seq !== requestSeq.current || !open) return;
        setStatus(response.status);
        previousBusy.current = response.status.busy;
        if (response.status.busy) {
          pollTimer.current = setTimeout(() => void refreshStatus(seq), POLL_INTERVAL_MS);
        } else if (response.status.installed) {
          await loadGraph(seq);
        }
      } catch (caught) {
        if (seq === requestSeq.current && open) setError(`Graphify를 불러오지 못했습니다: ${errorMessage(caught)}`);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    })();
    return () => {
      requestSeq.current += 1;
      clearPoll();
      pollInFlight.current = false;
      pendingAction.current = undefined;
    };
  }, [clearPoll, loadGraph, open, project.id, refreshStatus]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      requestSeq.current += 1;
      clearPoll();
      pollInFlight.current = false;
      setPending(undefined);
      pendingAction.current = undefined;
    }
    onOpenChange(nextOpen);
  };

  const communities = useMemo(() => {
    if (!graph) return [];
    return [...new Set(graph.nodes.map((node) => node.community))].sort((left, right) => left.localeCompare(right));
  }, [graph]);
  const filterIds = useMemo(() => {
    if (!graph || (!search.trim() && community === "all")) return undefined;
    return new Set(graph.nodes.filter((node) => matchesNode(node, search, community)).map((node) => node.id));
  }, [community, graph, search]);
  const visibleNodes = useMemo(() => graph ? selectVisibleNodes(graph.nodes, graph.edges, selectedNodeId, filterIds, highlightedNodeIds) : [], [filterIds, graph, selectedNodeId, highlightedNodeIds]);
  const selectedNode = graph?.nodes.find((node) => node.id === selectedNodeId);
  const matchingNodes = useMemo(() => graph ? graph.nodes.filter((node) => matchesNode(node, search, community)).sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label)) : [], [community, graph, search]);
  const connectedEdges = useMemo(() => selectedNode ? graph?.edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id) ?? [] : [], [graph?.edges, selectedNode]);
  const canAnalyze = !!status?.installed && !status.busy && !pending && !loading;
  const canBuild = !!status?.installed && !status.busy && !pending && !loading;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent title={`GRAPHIFY · ${project.name}`} description="로컬 코드 전용 · 프로젝트 폴더의 구조와 연결만 읽습니다." className="!flex w-[min(1180px,calc(100vw-28px))] max-h-[94vh] flex-col gap-3 overflow-y-auto p-5" data-testid="graphify-dialog">
        <div className="flex min-h-0 shrink-0 flex-col gap-4">
          <header className="flex flex-wrap items-center gap-3 border-b border-border/70 pb-3">
            <div className="min-w-0">
              <div className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground">GRAPHIFY / LOCAL SOURCE</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge className="border-success/40 text-success"><Code2 className="size-3" />로컬 코드 전용</Badge>
                <Badge className="font-mono">v{status?.version || GRAPHIFY_VERSION} · 고정 버전</Badge>
              </div>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2 [&_button]:text-foreground">
              {status && <Button type="button" size="sm" variant="outline" onClick={() => void refreshStatus(requestSeq.current)} disabled={!!pending || loading} aria-label="Graphify 상태 새로고침" data-testid="graphify-refresh"><RefreshCw className={loading ? "animate-spin" : undefined} />새로고침</Button>}
              {status?.busy ? (
                <Button type="button" size="sm" variant="destructive" onClick={() => void run("cancel")} disabled={!!pending} data-testid="graphify-cancel"><Ban />중지</Button>
              ) : !status?.installed ? (
                <Button type="button" size="sm" onClick={() => void run("install")} disabled={!!pending || loading} data-testid="graphify-install"><DownloadIcon />Graphify 설치</Button>
              ) : (
                <Button type="button" size="sm" onClick={() => void run("build")} disabled={!canBuild} data-testid="graphify-build"><Hammer />{status.nodeCount ? "그래프 업데이트" : "그래프 생성"}</Button>
              )}
            </div>
          </header>

          <StatusSummary status={status} graph={graph} />

          {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-[12px] text-destructive" data-testid="graphify-error"><CircleAlert className="mt-0.5 size-4 shrink-0" /><span>{error}</span></div>}
          {status?.error && !error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-warning/50 bg-warning/5 p-3 text-[12px] text-warning" data-testid="graphify-status-error"><CircleAlert className="mt-0.5 size-4 shrink-0" /><span>{status.error}</span></div>}

          {status?.busy && (
            <section className="grid gap-1.5 rounded-lg border border-primary/30 bg-primary/5 p-3 text-[12px]" role="status" aria-live="polite" data-testid="graphify-progress">
              <div className="flex items-center gap-2 font-medium"><Loader2 className="size-4 animate-spin text-primary" />{status.phase || "Graphify 작업 진행 중"}<span className="ml-auto text-muted-foreground">자동 새로고침</span></div>
              {status.log && <pre className="max-h-20 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">{status.log}</pre>}
            </section>
          )}

          {loading && !status && <div className="grid min-h-48 place-items-center gap-2 rounded-lg border text-[12px] text-muted-foreground"><Loader2 className="size-5 animate-spin" />Graphify 상태를 불러오는 중입니다.</div>}

          {status && !status.installed && !status.busy && !loading && (
            <section className="grid min-h-48 place-items-center gap-3 rounded-lg border border-dashed p-8 text-center" data-testid="graphify-install-state">
              <div className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground"><DownloadIcon /></div>
              <div><p className="font-medium">Graphify가 아직 설치되지 않았습니다.</p><p className="mt-1 text-[12px] text-muted-foreground">설치 후 프로젝트 폴더의 코드만 읽어 지식 그래프를 생성합니다.</p></div>
              <Button type="button" onClick={() => void run("install")} disabled={!!pending} data-testid="graphify-install-start"><DownloadIcon />{pending === "install" ? "설치 중" : "설치 시작"}</Button>
            </section>
          )}

          {status?.installed && !graph && !status.busy && !loading && (
            <section className="grid min-h-48 place-items-center gap-3 rounded-lg border border-dashed p-8 text-center" data-testid="graphify-empty-state">
              <div className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground"><Network /></div>
              <div><p className="font-medium">아직 생성된 그래프가 없습니다.</p><p className="mt-1 text-[12px] text-muted-foreground">그래프 생성을 시작하면 파일과 코드 요소의 연결을 표시합니다.</p></div>
              <Button type="button" onClick={() => void run("build")} disabled={!!pending} data-testid="graphify-empty-build"><Hammer />그래프 생성</Button>
            </section>
          )}

          {graph && status?.installed && (
            <div className="grid min-w-0 gap-4">
              <section className="grid min-w-0 gap-2">
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <div className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground">GRAPH / CORE VIEW</div>
                  <span className="text-[11px] text-muted-foreground" title="연결 수가 많을수록 원이 커집니다.">핵심 노드 {visibleNodes.length.toLocaleString("ko-KR")} / 전체 {graph.nodes.length.toLocaleString("ko-KR")}</span>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <div className="relative min-w-[180px] flex-1"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="노드, 파일, 유형 검색" aria-label="노드 검색" className="pl-8" data-testid="graphify-search" /></div>
                  <select value={community} onChange={(event) => setCommunity(event.target.value)} aria-label="커뮤니티 필터" className="h-9 rounded-md border border-input bg-transparent px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30" data-testid="graphify-community-filter">
                    <option value="all">모든 커뮤니티</option>
                    {communities.map((item) => <option key={item} value={item}>커뮤니티 {item}</option>)}
                  </select>
                </div>
                <div className="h-[clamp(340px,52vh,540px)] min-h-[340px] w-full"><GraphifyCanvas graph={graph} selectedNodeId={selectedNodeId} highlightedNodeIds={highlightedNodeIds} filterIds={filterIds} onSelectNode={(nodeId) => { setSelectedNodeId(nodeId); setResultText(undefined); setHighlightedNodeIds(new Set()); }} /></div>
                {status.stale && <div className="flex items-center gap-2 text-[11px] text-warning"><CircleAlert className="size-3.5" />생성 후 시간이 지났습니다. 소스를 변경했다면 그래프를 업데이트하세요.</div>}
              </section>

              <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
                <section className="grid min-w-0 content-start gap-3">
                  <section className="grid min-w-0 gap-2 border border-border/70 p-3" aria-label="노드 목록">
                    <div className="flex flex-wrap items-end justify-between gap-2"><div className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground">CORE NODES</div><span className="text-[11px] text-muted-foreground">검색 {matchingNodes.length.toLocaleString("ko-KR")}</span></div>
                    <div className="max-h-44 min-w-0 overflow-y-auto" role="listbox" aria-label="그래프 노드">
                      {matchingNodes.slice(0, NODE_LIST_LIMIT).map((node) => <button key={node.id} type="button" role="option" aria-selected={node.id === selectedNodeId} onClick={() => { setSelectedNodeId(node.id); setResultText(undefined); setHighlightedNodeIds(new Set()); }} className={`flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left text-[11px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 ${node.id === selectedNodeId ? "bg-accent" : ""}`}>
                        <span className="mt-1 size-2 shrink-0 rounded-full" style={{ backgroundColor: graphCommunityColor(node.community) }} title={`커뮤니티 ${node.community}`} /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{node.label}</span><span className="block truncate text-muted-foreground">{node.sourceFile}</span></span><span className="tabular-nums text-muted-foreground">{node.degree}</span>
                      </button>)}
                      {!matchingNodes.length && <p className="px-2 py-3 text-[11px] text-muted-foreground">조건에 맞는 노드가 없습니다.</p>}
                    </div>
                    {matchingNodes.length > NODE_LIST_LIMIT && <p className="text-[10px] text-muted-foreground">상위 {NODE_LIST_LIMIT}개만 표시합니다. 검색어로 범위를 좁힐 수 있습니다.</p>}
                  </section>

                  {graph.report && <details className="border border-border/70 text-[11px]" data-testid="graphify-report">
                    <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50" data-testid="graphify-report-toggle"><span className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground">REPORT</span><span className="font-medium">분석 보고서 보기</span></summary>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap border-t border-border/70 px-3 py-2 font-mono leading-relaxed text-muted-foreground select-text">{graph.report}</pre>
                  </details>}
                </section>

                <aside className="grid min-w-0 content-start gap-3">
                  {selectedNode ? <NodeDetails node={selectedNode} connectedEdges={connectedEdges} graph={graph} canAnalyze={canAnalyze} onExplain={() => void run("explain", { node: selectedNode.id })} onOpenSource={() => void run("open-source", { node: selectedNode.id })} onPath={(to) => void run("path", { node: selectedNode.id, to })} /> : <div className="grid min-h-40 place-items-center border border-border/70 p-4 text-center text-[12px] text-muted-foreground"><Info className="size-5" />노드 목록이나 그래프에서 노드를 선택하면 소스와 연결을 확인할 수 있습니다.</div>}

                  <section className="grid min-w-0 gap-2 border border-border/70 p-3">
                    <div className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground">GRAPH QUERY</div>
                    <div className="flex min-w-0 gap-2"><Input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && query.trim()) void run("query", { query: query.trim() }); }} placeholder="함수, 파일, 개념 검색" aria-label="그래프 검색" className="min-w-0 text-[12px]" /><Button type="button" size="sm" onClick={() => void run("query", { query: query.trim() })} disabled={!canAnalyze || !query.trim()} aria-label="그래프 검색 실행" data-testid="graphify-query-submit"><Search /></Button></div>
                  </section>
                  <ActionResult text={resultText} />
                </aside>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NodeDetails({ node, connectedEdges, graph, canAnalyze, onExplain, onOpenSource, onPath }: { node: GraphifyNode; connectedEdges: GraphifyGraph["edges"]; graph: GraphifyGraph; canAnalyze: boolean; onExplain: () => void; onOpenSource: () => void; onPath: (to: string) => void }) {
  const [pathTargetQuery, setPathTargetQuery] = useState("");
  useEffect(() => setPathTargetQuery(""), [node.id]);
  const byId = new Map(graph.nodes.map((item) => [item.id, item]));
  const matchingTargets = graph.nodes
    .filter((item) => item.id !== node.id && matchesNode(item, pathTargetQuery, "all"))
    .sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label));
  const targetNodes = matchingTargets.slice(0, PATH_TARGET_LIMIT);
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 border border-border/70 p-3" data-testid="graphify-node-details">
      <div className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground">NODE DETAIL</div>
      <div className="flex items-start gap-2"><FileCode2 className="mt-0.5 size-4 shrink-0 text-primary" /><div className="min-w-0"><h3 className="truncate text-[13px] font-medium">{node.label}</h3><p className="truncate font-mono text-[10.5px] text-muted-foreground">{sourceLocation(node)}</p></div></div>
      <dl className="grid gap-1 text-[11px]"><div className="flex gap-2"><dt className="w-14 shrink-0 text-muted-foreground">파일</dt><dd className="min-w-0 truncate" title={node.sourceFile}>{node.sourceFile}</dd></div><div className="flex gap-2"><dt className="w-14 shrink-0 text-muted-foreground">라인</dt><dd>{node.line ?? "알 수 없음"}</dd></div><div className="flex gap-2"><dt className="w-14 shrink-0 text-muted-foreground">유형</dt><dd>{node.kind || "알 수 없음"}</dd></div><div className="flex gap-2"><dt className="w-14 shrink-0 text-muted-foreground">커뮤니티</dt><dd>{node.community}</dd></div><div className="flex gap-2"><dt className="w-14 shrink-0 text-muted-foreground">설명</dt><dd className="leading-relaxed text-muted-foreground">{node.description || "설명이 없습니다."}</dd></div></dl>
      <div className="flex flex-wrap gap-1.5"><Button type="button" size="xs" onClick={() => onExplain()} disabled={!canAnalyze} data-testid="graphify-explain"><Sparkles />설명</Button><Button type="button" size="xs" variant="outline" onClick={onOpenSource} disabled={!canAnalyze} data-testid="graphify-open-source"><ExternalLink />파일 위치</Button></div>
      <div className="grid gap-1.5 border-t pt-2"><div className="text-[11px] font-medium">연결 {connectedEdges.length}</div>{connectedEdges.slice(0, 16).map((edge, index) => { const otherId = edge.source === node.id ? edge.target : edge.source; const other = byId.get(otherId); if (!other) return null; const confidence = confidenceLabel(edge.confidence); const confidenceClass = confidence === "EXTRACTED" ? "border-success/40 text-success" : confidence === "INFERRED" ? "border-primary/40 text-primary" : confidence === "AMBIGUOUS" ? "border-warning/40 text-warning" : "border-muted-foreground/40 text-muted-foreground"; return <div key={`${otherId}-${edge.relation}-${index}`} className="flex items-center gap-1.5 text-[10.5px]"><button type="button" className="min-w-0 flex-1 truncate text-left text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={() => onPath(other.id)} title={`${other.label} 경로 보기`} data-testid="graphify-path">{other.label}</button><Badge className={confidenceClass}>{confidence}</Badge><span className="max-w-20 truncate text-muted-foreground">{edge.relation}</span></div>; })}{connectedEdges.length > 16 && <span className="text-[10px] text-muted-foreground">상위 16개 연결만 표시합니다.</span>}</div>
      <div className="grid gap-1.5 border-t pt-2"><div className="text-[11px] font-medium">경로 대상 검색</div><Input value={pathTargetQuery} onChange={(event) => setPathTargetQuery(event.target.value)} placeholder="함수, 파일, 개념 검색" aria-label="경로 대상 검색" className="text-[11px]" data-testid="graphify-path-target-search" />{pathTargetQuery.trim() ? <div className="max-h-36 overflow-y-auto" role="listbox" aria-label="경로 대상 노드">{targetNodes.map((target) => <button key={target.id} type="button" role="option" className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[11px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={() => onPath(target.id)} data-testid="graphify-path-target"><span className="min-w-0 flex-1"><span className="block truncate font-medium">{target.label}</span><span className="block truncate text-muted-foreground">{target.sourceFile}</span></span><span className="tabular-nums text-muted-foreground">{target.degree}</span></button>)}{!targetNodes.length && <p className="px-2 py-2 text-[10px] text-muted-foreground">검색 결과가 없습니다.</p>}{matchingTargets.length > PATH_TARGET_LIMIT && <p className="px-2 py-1 text-[10px] text-muted-foreground">상위 {PATH_TARGET_LIMIT}개만 표시합니다.</p>}</div> : <p className="text-[10px] text-muted-foreground">현재 노드에서 이동할 대상 노드를 검색하세요.</p>}</div>
      {connectedEdges.length === 0 && <p className="text-[11px] text-muted-foreground">연결된 노드가 없습니다.</p>}
    </section>
  );
}

function DownloadIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 20h14" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
