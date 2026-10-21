export const GRAPHIFY_VERSION = "0.9.93";

export interface GraphifyNode {
  id: string;
  label: string;
  kind: string;
  sourceFile: string;
  line?: number;
  community: string;
  description: string;
  degree: number;
}
export interface GraphifyEdge {
  source: string;
  target: string;
  relation: string;
  confidence: string;
}
export interface GraphifyGraph {
  nodes: GraphifyNode[];
  edges: GraphifyEdge[];
  generatedAt: number;
  root: string;
  version: string;
  report?: string;
}
export interface GraphifyStatus {
  installed: boolean;
  version: string;
  busy: boolean;
  phase: string;
  log: string;
  error?: string;
  generatedAt?: number;
  nodeCount: number;
  edgeCount: number;
  stale: boolean;
}
export type GraphifyAction = "status" | "install" | "build" | "cancel" | "graph" | "query" | "explain" | "path" | "open-source";
export interface GraphifyRequest {
  projectId: number;
  action: GraphifyAction;
  query?: string;
  node?: string;
  to?: string;
}
export interface GraphifyResult {
  text: string;
  nodeIds: string[];
}
export interface GraphifyResponse {
  status: GraphifyStatus;
  graph?: GraphifyGraph;
  result?: GraphifyResult;
}
