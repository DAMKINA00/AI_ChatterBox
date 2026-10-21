import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import type { GraphifyEdge, GraphifyGraph, GraphifyNode } from "../../../shared/graphify";
import { Button } from "./ui";

export const GRAPHIFY_VISIBLE_NODE_LIMIT = 72;
const WIDTH = 1280, HEIGHT = 530;
const COMMUNITY_COLORS = ["#8bb5d5", "#b3a0e2", "#83bd9a", "#d6b477", "#d58d9e", "#7fbcc0", "#ce9879"];
export function graphCommunityColor(community: string): string {
  let hash = 0;
  for (const character of community) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return COMMUNITY_COLORS[Math.abs(hash) % COMMUNITY_COLORS.length];
}
function byDegree(a: GraphifyNode, b: GraphifyNode) {
  return b.degree - a.degree || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}
export function selectVisibleNodes(nodes: GraphifyNode[], edges: GraphifyEdge[], selectedNodeId?: string, filterIds?: ReadonlySet<string>, highlightedIds?: ReadonlySet<string>): GraphifyNode[] {
  const ranked = nodes.filter(n => !filterIds || filterIds.has(n.id)).sort(byDegree);
  const neighbors = new Set<string>();
  for (const edge of edges) {
    if (edge.source === selectedNodeId) neighbors.add(edge.target);
    if (edge.target === selectedNodeId) neighbors.add(edge.source);
  }
  const groups = new Map<string, GraphifyNode[]>();
  for (const node of ranked) {
    if (!groups.has(node.community)) groups.set(node.community, []);
    groups.get(node.community)!.push(node);
  }
  // Keep the largest hubs, then give each community room in the overview.
  const balanced: GraphifyNode[] = [];
  for (let index = 0; balanced.length < GRAPHIFY_VISIBLE_NODE_LIMIT; index++) {
    let added = false;
    for (const members of groups.values()) if (members[index]) { balanced.push(members[index]); added = true; }
    if (!added) break;
  }
  return [...new Map([
    ...ranked.filter(n => n.id === selectedNodeId),
    ...ranked.filter(n => highlightedIds?.has(n.id)),
    ...ranked.filter(n => neighbors.has(n.id)).slice(0, 36),
    ...ranked.slice(0, 12), ...balanced,
  ].map(n => [n.id, n])).values()].slice(0, GRAPHIFY_VISIBLE_NODE_LIMIT);
}
export function graphNodeRadius(degree: number, maxDegree: number): number {
  return 4 + 19 * Math.pow(Math.max(0, degree) / Math.max(1, maxDegree), 0.6);
}
interface Position { x: number; y: number }
export function layoutGraph(nodes: GraphifyNode[], edges: GraphifyEdge[]): Map<string, Position> {
  const maxDegree = Math.max(1, ...nodes.map(n => n.degree));
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const points = nodes.map((node, index) => ({
    id: node.id, radius: graphNodeRadius(node.degree, maxDegree),
    x: WIDTH / 2 + Math.cos(index * goldenAngle) * Math.sqrt((index + 0.5) / nodes.length) * 340,
    y: HEIGHT / 2 + Math.sin(index * goldenAngle) * Math.sqrt((index + 0.5) / nodes.length) * 190,
  }));
  const byId = new Map(points.map(p => [p.id, p]));
  const links = edges.flatMap(e => {
    const a = byId.get(e.source), b = byId.get(e.target);
    return a && b && a !== b ? [[a, b]] : [];
  });
  for (let step = 0; step < 260; step++) {
    const forces = new Map(points.map(p => [p.id, { x: (WIDTH / 2 - p.x) * 0.008, y: (HEIGHT / 2 - p.y) * 0.008 }]));
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      const a = points[i], b = points[j];
      const dx = b.x - a.x || 0.01, dy = b.y - a.y || 0.01, distance = Math.max(1, Math.hypot(dx, dy));
      const minimum = a.radius + b.radius + 35;
      const push = 850 / (distance * distance) + Math.max(0, minimum - distance) * 0.14;
      forces.get(a.id)!.x -= dx / distance * push; forces.get(a.id)!.y -= dy / distance * push;
      forces.get(b.id)!.x += dx / distance * push; forces.get(b.id)!.y += dy / distance * push;
    }
    for (const [a, b] of links) {
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
      const pull = Math.max(0, distance - 100 - a.radius - b.radius) * 0.012;
      forces.get(a.id)!.x += dx / distance * pull; forces.get(a.id)!.y += dy / distance * pull;
      forces.get(b.id)!.x -= dx / distance * pull; forces.get(b.id)!.y -= dy / distance * pull;
    }
    const cooling = 1 - step / 340;
    for (const p of points) {
      const f = forces.get(p.id)!;
      p.x = Math.min(WIDTH - 65, Math.max(65, p.x + Math.max(-12, Math.min(12, f.x)) * cooling));
      p.y = Math.min(HEIGHT - 55, Math.max(45, p.y + Math.max(-12, Math.min(12, f.y)) * cooling));
    }
  }
  if (points.length < 2) return new Map(points.map(p => [p.id, { x: WIDTH / 2, y: HEIGHT / 2 }]));
  const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
  return new Map(points.map(p => [p.id, {
    x: maxX - minX < 1 ? WIDTH / 2 : 75 + (p.x - minX) / (maxX - minX) * (WIDTH - 150),
    y: maxY - minY < 1 ? HEIGHT / 2 : 55 + (p.y - minY) / (maxY - minY) * (HEIGHT - 115),
  }]));
}
export interface GraphifyCanvasProps {
  graph: GraphifyGraph;
  selectedNodeId?: string;
  highlightedNodeIds?: ReadonlySet<string>;
  filterIds?: ReadonlySet<string>;
  onSelectNode: (nodeId: string) => void;
}
export function GraphifyCanvas({ graph, selectedNodeId, highlightedNodeIds, filterIds, onSelectNode }: GraphifyCanvasProps) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [hoveredId, setHoveredId] = useState<string>();
  const dragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number; factor: number } | undefined>(undefined);
  const nodes = useMemo(() => selectVisibleNodes(graph.nodes, graph.edges, selectedNodeId, filterIds, highlightedNodeIds), [graph, selectedNodeId, filterIds, highlightedNodeIds]);
  const edges = useMemo(() => {
    const ids = new Set(nodes.map(n => n.id));
    const priority = (e: GraphifyEdge) => (e.source === selectedNodeId || e.target === selectedNodeId ? 2 : 0) + (highlightedNodeIds?.has(e.source) && highlightedNodeIds.has(e.target) ? 4 : 0);
    return graph.edges.filter(e => ids.has(e.source) && ids.has(e.target)).sort((a, b) => priority(b) - priority(a)).slice(0, 180);
  }, [graph.edges, nodes, selectedNodeId, highlightedNodeIds]);
  const positions = useMemo(() => layoutGraph(nodes, edges), [nodes, edges]);
  const maxDegree = Math.max(1, ...nodes.map(n => n.degree));
  const focusId = hoveredId ?? selectedNodeId;
  const related = new Set<string>(focusId ? [focusId] : []);
  for (const e of edges) {
    if (e.source === focusId) related.add(e.target);
    if (e.target === focusId) related.add(e.source);
  }
  const zoom = (factor: number) => setScale(current => Math.min(3.5, Math.max(0.5, current * factor)));
  const startDragging = (event: ReactPointerEvent<SVGSVGElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y, factor: Math.min(event.currentTarget.clientWidth / WIDTH, event.currentTarget.clientHeight / HEIGHT) };
  };
  const usedLabels: { x: number; y: number; w: number; h: number }[] = [];
  const labels = new Map<string, { x: number; y: number; text: string }>();
  for (const n of [...nodes].sort((a, b) => Number(b.id === focusId) - Number(a.id === focusId) || byDegree(a, b))) {
    const p = positions.get(n.id)!;
    const r = graphNodeRadius(n.degree, maxDegree);
    const text = n.label.length > 27 ? `${n.label.slice(0, 26)}…` : n.label;
    const w = text.length * 5.7 + 8;
    for (const y of [p.y + r + 15, p.y - r - 9]) {
      const box = { x: Math.max(4, Math.min(WIDTH - w - 4, p.x - w / 2)), y: y - 10, w, h: 13 };
      if (usedLabels.some(b => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y)) continue;
      usedLabels.push(box); labels.set(n.id, { x: box.x + w / 2, y, text }); break;
    }
  }
  return (
    <div className="graphify-map relative h-full min-h-[300px] overflow-hidden rounded-lg border" data-testid="graphify-canvas">
      <div className="absolute top-3 left-4 z-10 flex flex-wrap items-center gap-4 font-mono text-[9px] text-muted-foreground pointer-events-none">
        <span>STRUCTURE MAP</span><span className="flex items-center gap-1.5"><i className="w-5 border-t" />EXTRACTED</span><span className="flex items-center gap-1.5"><i className="w-5 border-t border-dashed" />INFERRED</span>
      </div>
      <div className="absolute top-2 right-2 z-10 flex gap-0.5 rounded-md border bg-card/90 p-0.5 [&_button]:text-foreground" aria-label="그래프 확대 축소">
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => zoom(1.2)} aria-label="확대"><Plus /></Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => zoom(0.83)} aria-label="축소"><Minus /></Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }} aria-label="그래프 보기 초기화"><RotateCcw /></Button>
      </div>
      <svg className="h-full w-full touch-none select-none" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`코드 지식 그래프, ${nodes.length}개 노드`} tabIndex={0}
        onWheel={e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 0.9); }} onPointerDown={startDragging}
        onPointerMove={e => { const d = dragRef.current; if (d) setOffset({ x: d.offsetX + (e.clientX - d.x) / d.factor, y: d.offsetY + (e.clientY - d.y) / d.factor }); }}
        onPointerUp={() => { dragRef.current = undefined; }} onPointerCancel={() => { dragRef.current = undefined; }}>
        <g transform={`translate(${WIDTH / 2 + offset.x} ${HEIGHT / 2 + offset.y}) scale(${scale}) translate(${-WIDTH / 2} ${-HEIGHT / 2})`}>
          {edges.map((e, index) => {
            const a = positions.get(e.source)!, b = positions.get(e.target)!;
            const active = e.source === focusId || e.target === focusId;
            const path = highlightedNodeIds?.has(e.source) && highlightedNodeIds.has(e.target);
            return <line key={`${e.source}-${e.target}-${index}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              className={path ? "graphify-path" : "graphify-edge"} stroke={path ? "#d6b477" : active ? graphCommunityColor(nodes.find(n => n.id === focusId)?.community ?? "") : "var(--muted-foreground)"}
              strokeOpacity={path ? 0.95 : active ? 0.85 : focusId ? 0.12 : 0.26} strokeWidth={path ? 2.1 : active ? 1.6 : 0.8} strokeDasharray={e.confidence.toUpperCase() === "EXTRACTED" ? undefined : "3 5"} />;
          })}
          {nodes.map(n => {
            const p = positions.get(n.id)!;
            const selected = n.id === selectedNodeId, focused = n.id === focusId, highlighted = highlightedNodeIds?.has(n.id);
            const radius = graphNodeRadius(n.degree, maxDegree), color = graphCommunityColor(n.community), label = labels.get(n.id);
            return <g key={n.id} className="graphify-node cursor-pointer" role="button" aria-label={`${n.label} · ${n.sourceFile}`} tabIndex={0}
              data-node-id={n.id} data-degree={n.degree} onPointerDown={e => e.stopPropagation()} onMouseEnter={() => setHoveredId(n.id)} onMouseLeave={() => setHoveredId(undefined)}
              onFocus={() => setHoveredId(n.id)} onBlur={() => setHoveredId(undefined)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectNode(n.id); } }} onClick={e => { e.stopPropagation(); onSelectNode(n.id); }}>
              <title>{`${n.label} · 연결 ${n.degree}\n${n.sourceFile}${n.line ? `:${n.line}` : ""}`}</title>
              {(radius > 14 || selected || highlighted) && <circle cx={p.x} cy={p.y} r={radius + 7} fill={color} opacity={focused ? 0.18 : 0.08} />}
              {selected && <circle key={`ring-${n.id}`} className="graphify-selection-ring" cx={p.x} cy={p.y} r={radius + 7} fill="none" stroke={color} strokeWidth="1.2" />}
              <circle className="graphify-node-core" cx={p.x} cy={p.y} r={radius + (focused ? 2 : 0)} fill={color} fillOpacity={focusId && !related.has(n.id) && !highlighted ? 0.4 : 0.92} stroke={highlighted ? "#d6b477" : color} strokeWidth={highlighted || focused ? 2 : 0.6} />
              {label && <text x={label.x} y={label.y} textAnchor="middle" className="graphify-label" fill="var(--foreground)" fontSize={focused || radius > 14 ? 11 : 9.5} fontWeight={focused || radius > 14 ? 600 : 400} opacity={focusId && !related.has(n.id) && !highlighted ? 0.35 : focused || radius > 14 ? 1 : 0.72}>{label.text}</text>}
            </g>;
          })}
        </g>
      </svg>
      {!nodes.length && <div className="pointer-events-none absolute inset-0 grid place-items-center text-[12px] text-muted-foreground">검색 조건에 맞는 노드가 없습니다.</div>}
      <div className="pointer-events-none absolute bottom-3 left-4 font-mono text-[9px] text-muted-foreground">원 크기 · 연결 수 / 드래그 · 이동 / 휠 · 확대</div>
    </div>
  );
}
