import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { GRAPHIFY_VERSION, type GraphifyGraph, type GraphifyRequest, type GraphifyResponse } from "../shared/graphify";
import type { Project } from "../shared/types";
import { killTree } from "./proc";

const MAX_GRAPH_BYTES = 32 * 1024 * 1024;
const ACTIONS = new Set(["status", "install", "build", "cancel", "graph", "query", "explain", "path", "open-source"]);
const string = (value: unknown, max = 2000) => typeof value === "string" ? value.slice(0, max) : "";
const projectKey = (project: Project, root: string) => `${project.id}-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;

export function parseGraph(raw: any, root: string, generatedAt: number): GraphifyGraph {
  if (!Array.isArray(raw?.nodes) || !Array.isArray(raw.links ?? raw.edges) || raw.graph?.schema_version !== 1)
    throw new Error("지원하지 않는 Graphify 그래프 형식입니다.");
  const ids = new Set<string>();
  const nodes = raw.nodes.map((node: any) => {
    const id = string(node.id);
    if (!id || ids.has(id)) throw new Error("그래프 노드 ID가 없거나 중복됩니다.");
    ids.add(id);
    const line = /^L(\d+)/.exec(string(node.source_location));
    return { id, label: string(node.label) || id, kind: string(node.type ?? node.file_type) || "code",
      sourceFile: string(node.source_file), line: line ? Number(line[1]) : undefined,
      community: String(node.community ?? "0"), description: string(node.description, 8000), degree: 0 };
  });
  const byId = new Map<string, typeof nodes[number]>(nodes.map((node: any) => [node.id, node]));
  const edges = (raw.links ?? raw.edges).map((edge: any) => {
    const source = string(edge.source), target = string(edge.target);
    if (!ids.has(source) || !ids.has(target)) throw new Error("그래프 연결의 노드를 찾을 수 없습니다.");
    byId.get(source)!.degree++; byId.get(target)!.degree++;
    return { source, target, relation: string(edge.relation) || "related", confidence: string(edge.confidence) || "UNKNOWN" };
  });
  return { nodes, edges, root, generatedAt, version: string(raw.graph.graphify_version) || GRAPHIFY_VERSION };
}

export async function graphSource(root: string, source: string): Promise<string> {
  if (!source || isAbsolute(source) || source.includes(":")) throw new Error("프로젝트 외부 소스는 열 수 없습니다.");
  const canonicalRoot = await realpath(root), file = await realpath(resolve(root, source));
  const rel = relative(canonicalRoot, file);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !(await stat(file)).isFile())
    throw new Error("프로젝트 외부 소스는 열 수 없습니다.");
  return file;
}

interface Job { phase: string; log: string; error?: string; busy: boolean; cancelled: boolean; child?: ChildProcess; done?: Promise<void> }
interface Snapshot { folder: string; graph: GraphifyGraph }

export class GraphifyService {
  readonly base: string;
  readonly python: string;
  private installed = false;
  private installation?: Job;
  private jobs = new Map<string, Job>();
  private snapshots = new Map<string, Snapshot>();
  private queries = new Set<Job>();
  private preparations = new Map<string, Promise<GraphifyResponse>>();
  private disposed = false;
  private ready: Promise<void>;

  constructor(dataDir: string) {
    this.base = join(dataDir, "graphify");
    this.python = join(this.base, "runtime", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    this.ready = readFile(join(this.base, "installed-version"), "utf8").then(async v => {
      if (v.trim() !== GRAPHIFY_VERSION || !existsSync(this.python)) return;
      const job: Job = { phase: "설치 확인", log: "", busy: true, cancelled: false };
      this.queries.add(job);
      try {
        const result = await this.run(this.python, ["-I", "-m", "graphify", "--version"], job, this.base, 10_000);
        this.installed = result.code === 0 && result.text.trim() === `graphify ${GRAPHIFY_VERSION}`;
      } finally { this.queries.delete(job); }
    }).catch(() => {});
  }

  private run(executable: string, args: string[], job: Job, cwd: string, timeout = 15 * 60_000): Promise<{ code: number; text: string }> {
    if (job.cancelled) return Promise.reject(new Error("사용자가 취소했습니다."));
    const env: NodeJS.ProcessEnv = { ...process.env, GRAPHIFY_BACKEND: "none", GRAPHIFY_OUT: "graphify-out", GRAPHIFY_QUERY_LOG_DISABLE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
    delete env.PYTHONPATH; delete env.PYTHONHOME;
    return new Promise((done, reject) => {
      const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      job.child = child;
      let output = "", timedOut = false;
      const append = (data: string) => { output = (output + data).slice(-48_000); job.log = (job.log + data).slice(-8000); };
      child.stdout.setEncoding("utf8").on("data", append);
      child.stderr.setEncoding("utf8").on("data", append);
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
      child.once("error", error => { clearTimeout(timer); job.child = undefined; reject(error); });
      child.once("close", code => {
        clearTimeout(timer); job.child = undefined;
        if (job.cancelled || timedOut) reject(new Error(timedOut ? "분석 시간이 초과되었습니다." : "사용자가 취소했습니다."));
        else done({ code: code ?? 1, text: output });
      });
    });
  }

  private async cli(args: string[], job: Job, cwd: string, query = false) {
    const result = await this.run(this.python, ["-I", "-m", "graphify", ...args], job, cwd, query ? 60_000 : 15 * 60_000);
    if (result.code !== 0 && !(query && [3, 4].includes(result.code))) throw new Error(result.text.slice(-4000) || `Graphify 종료 코드 ${result.code}`);
    return result.text;
  }

  private start(job: Job, work: () => Promise<void>) {
    job.done = work().then(() => { job.phase = "완료"; }).catch(error => {
      job.phase = job.cancelled ? "취소됨" : "실패";
      if (!job.cancelled) job.error = error instanceof Error ? error.message : String(error);
    }).finally(() => { job.busy = false; });
  }

  private async install(job: Job) {
    await mkdir(this.base, { recursive: true });
    // Isolated Python never imports code from the project being inspected.
    const names = process.platform === "win32" ? ["python.exe", "python3.exe", "py.exe"] : ["python3", "python"];
    const candidates = (process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap(dir => names.map(name => join(dir, name)));
    candidates.push(join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe"));
    let python: string | undefined;
    for (const path of [...new Set(candidates)].filter(existsSync)) {
      try {
        const test = await this.run(path, ["-I", "-c", "import sys; assert sys.version_info >= (3,10)"], job, this.base, 10_000);
        if (test.code === 0) { python = path; break; }
      } catch { if (job.cancelled) throw new Error("사용자가 취소했습니다."); }
    }
    if (!python) throw new Error("Python 3.10 이상이 필요합니다. Python을 설치하고 앱을 다시 실행해 주세요.");
    job.phase = "전용 Python 환경 준비";
    let result = await this.run(python, ["-I", "-m", "venv", join(this.base, "runtime")], job, this.base);
    if (result.code) throw new Error(result.text);
    job.phase = `Graphify ${GRAPHIFY_VERSION} 설치`;
    result = await this.run(this.python, ["-I", "-m", "pip", "--isolated", "install", "--force-reinstall", "--disable-pip-version-check", "--no-input", "--index-url", "https://pypi.org/simple", `graphifyy==${GRAPHIFY_VERSION}`], job, this.base);
    if (result.code) throw new Error(result.text);
    const version = await this.cli(["--version"], job, this.base);
    if (!version.includes(GRAPHIFY_VERSION)) throw new Error("설치된 Graphify 버전을 확인하지 못했습니다.");
    await writeFile(join(this.base, "installed-version"), GRAPHIFY_VERSION);
    this.installed = true;
  }

  private async load(key: string, root: string): Promise<Snapshot | undefined> {
    if (this.snapshots.has(key)) return this.snapshots.get(key);
    try {
      const meta = JSON.parse(await readFile(join(this.base, key, "current.json"), "utf8"));
      if (!/^[\da-f-]{36}$/.test(meta.generation) || meta.root !== root || !Number.isFinite(meta.generatedAt)) return;
      const folder = join(this.base, key, meta.generation, "graphify-out");
      const graph = await this.readGraph(folder, root, meta.generatedAt);
      const snapshot = { folder, graph }; this.snapshots.set(key, snapshot); return snapshot;
    } catch { return; }
  }

  private async readGraph(folder: string, root: string, generatedAt: number) {
    const path = join(folder, "graph.json");
    if ((await stat(path)).size > MAX_GRAPH_BYTES) throw new Error("그래프가 32MB를 초과했습니다. 프로젝트의 .graphifyignore로 분석 범위를 줄여 주세요.");
    const graph = parseGraph(JSON.parse(await readFile(path, "utf8")), root, generatedAt);
    graph.report = (await readFile(join(folder, "GRAPH_REPORT.md"), "utf8").catch(() => "")).slice(0, 80_000);
    return graph;
  }

  private async build(key: string, root: string, job: Job) {
    const generation = randomUUID(), cache = join(this.base, key), work = join(cache, generation), started = Date.now();
    await mkdir(work, { recursive: true });
    try {
      job.phase = "코드와 의존 관계 분석";
      const folder = join(work, "graphify-out");
      let empty = false;
      try { await this.cli(["extract", root, "--code-only", "--out", work], job, work); }
      catch (error) {
        // A new/unsupported-code project still needs a master analysis, without inventing relationships.
        if (job.cancelled || this.snapshots.has(key) || !(error instanceof Error) || !error.message.includes("[graphify extract] graph is empty — extraction produced no nodes.")) throw error;
        empty = true;
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "graph.json"), JSON.stringify({ graph: { schema_version: 1, graphify_version: GRAPHIFY_VERSION }, nodes: [], links: [] }));
        await writeFile(join(folder, "GRAPH_REPORT.md"), "# 구조 추출 결과: 노드 없음\n파서가 추출한 코드 노드가 없습니다. 빈 프로젝트, 제외 규칙 또는 미지원 언어일 수 있습니다. 마스터는 실제 파일과 사용자 요청을 확인하여 초기 구조와 검증 계획을 직접 분석해야 합니다. 코드가 추가되면 그래프를 업데이트하세요.\n");
      }
      if (!empty) {
        job.phase = "커뮤니티와 보고서 생성";
        await this.cli(["cluster-only", root, "--graph", join(folder, "graph.json"), "--no-label", "--no-viz"], job, work);
      }
      const graph = await this.readGraph(folder, root, started);
      if (job.cancelled) throw new Error("사용자가 취소했습니다.");
      await writeFile(join(cache, "current.tmp"), JSON.stringify({ generation, root, generatedAt: started }));
      if (job.cancelled) throw new Error("사용자가 취소했습니다.");
      await rename(join(cache, "current.tmp"), join(cache, "current.json"));
      const previous = this.snapshots.get(key)?.folder;
      this.snapshots.set(key, { folder, graph });
      if (!this.queries.size) for (const entry of await readdir(cache).catch(() => [])) {
        if (!/^[\da-f-]{36}$/.test(entry) || entry === generation || join(cache, entry, "graphify-out") === previous) continue;
        const old = resolve(cache, entry);
        if (relative(resolve(cache), old) === entry) await rm(old, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      // work is generated exclusively under this service's cache, never a project path.
      if (relative(resolve(this.base), resolve(work)).startsWith(`..${sep}`)) throw error;
      await rm(work, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /** Reuse a completed snapshot, or wait for the project's first extraction. */
  async prepare(project: Project): Promise<GraphifyResponse> {
    const key = projectKey(project, await realpath(project.folder));
    const existing = this.preparations.get(key);
    if (existing) return existing;
    const flight = this.prepareFirst(project, key).finally(() => this.preparations.delete(key));
    this.preparations.set(key, flight);
    return flight;
  }

  private async prepareFirst(project: Project, key: string): Promise<GraphifyResponse> {
    let response = await this.request(project, { projectId: project.id, action: "graph" });
    if (response.graph) return response;
    if (!response.status.installed) {
      await this.request(project, { projectId: project.id, action: "install" });
      await this.installation?.done;
      if (!this.installed) throw new Error(this.installation?.error || "Graphify 설치가 취소되었습니다.");
    }
    await this.request(project, { projectId: project.id, action: "build" });
    const job = this.jobs.get(key);
    await job?.done;
    response = await this.request(project, { projectId: project.id, action: "graph" });
    if (!response.graph) throw new Error(job?.error || "프로젝트의 최초 코드 분석이 취소되었습니다.");
    return response;
  }

  async request(project: Project, request: GraphifyRequest): Promise<GraphifyResponse> {
    if (!request || !ACTIONS.has(request.action)) throw new Error("지원하지 않는 그래프 작업입니다.");
    await this.ready;
    if (this.disposed) throw new Error("Graphify가 종료되었습니다.");
    const root = await realpath(project.folder);
    if (!(await stat(root)).isDirectory()) throw new Error("프로젝트 폴더가 없습니다.");
    const key = projectKey(project, root);
    let snapshot = await this.load(key, root), result: GraphifyResponse["result"];
    let job = this.jobs.get(key);
    if (request.action === "install" && !this.installed && !this.installation?.busy) {
      this.installation = { phase: "설치 준비", log: "", busy: true, cancelled: false };
      this.start(this.installation, () => this.install(this.installation!));
    }
    if (request.action === "build" && !job?.busy) {
      if (!this.installed || this.installation?.busy) throw new Error("먼저 프로젝트 그래프 화면에서 Graphify를 설치해 주세요.");
      job = { phase: "분석 준비", log: "", busy: true, cancelled: false }; this.jobs.set(key, job);
      this.start(job, () => this.build(key, root, job!));
    }
    if (request.action === "cancel") {
      const target = this.installation?.busy ? this.installation : job;
      if (target?.busy) { target.cancelled = true; target.phase = "취소 중"; if (target.child) killTree(target.child); }
    }
    if (["query", "explain", "path", "open-source"].includes(request.action)) {
      if (!snapshot) throw new Error("먼저 프로젝트 그래프를 생성해 주세요.");
      const graph = snapshot.graph;
      const node = graph.nodes.find(n => n.id === request.node);
      const to = graph.nodes.find(n => n.id === request.to);
      if (request.action !== "query" && !node) throw new Error("그래프 노드를 선택해 주세요.");
      if (request.action === "open-source") {
        const file = await graphSource(root, node!.sourceFile);
        const { shell } = await import("electron");
        shell.showItemInFolder(file);
        result = { text: `${node!.sourceFile}${node!.line ? `:${node!.line}` : ""}`, nodeIds: [node!.id] };
      } else {
        if (!this.installed) throw new Error("Graphify 설치가 필요합니다.");
        const query = string(request.query, 1000).trim();
        if (request.action === "query" && (!query || query.startsWith("-"))) throw new Error("검색할 함수나 개념을 입력해 주세요. 검색어는 '-'로 시작할 수 없습니다.");
        if (request.action === "path" && !to) throw new Error("경로의 도착 노드를 선택해 주세요.");
        // Graphify conflates file IDs such as "main" with main(); file paths select its file tier.
        const selector = (n: NonNullable<typeof node>) => n.sourceFile && n.line === 1 && (n.label === basename(n.sourceFile) || n.label.endsWith("/" + basename(n.sourceFile))) ? n.sourceFile : n.id;
        const args = request.action === "query" ? ["query", query] : request.action === "path" ? ["path", selector(node!), selector(to!), "--undirected"] : ["explain", selector(node!)];
        const queryJob: Job = { phase: "조회", log: "", busy: true, cancelled: false };
        this.queries.add(queryJob);
        try {
          const text = await this.cli([...args, "--graph", join(snapshot.folder, "graph.json")], queryJob, snapshot.folder, true);
          const matches = graph.nodes.filter(n => n.id === node?.id || n.id === to?.id || text.includes(n.id) || (n.label.length > 2 && text.includes(n.label))).slice(0, 60);
          result = { text: text + "\n\n조회된 노드 ID (원본 파일에서 확인):\n" + matches.map(n => `${n.id} — ${n.label} — ${n.sourceFile}${n.line ? `:${n.line}` : ""}`).join("\n"), nodeIds: matches.map(n => n.id) };
        } finally { this.queries.delete(queryJob); }
      }
    }
    snapshot = this.snapshots.get(key) ?? snapshot;
    const active = this.installation?.busy || !this.installed ? this.installation : job ?? this.installation;
    const graph = snapshot?.graph;
    // shortcut: snapshots age out after five minutes; refresh before relying on edits or newly added files.
    return { status: { installed: this.installed, version: GRAPHIFY_VERSION, busy: active?.busy ?? false,
      phase: active?.phase ?? "준비", log: active?.log ?? "", error: active?.error, generatedAt: graph?.generatedAt,
      nodeCount: graph?.nodes.length ?? 0, edgeCount: graph?.edges.length ?? 0, stale: !!graph && Date.now() - graph.generatedAt > 300_000 },
      graph: request.action === "graph" ? graph : undefined, result };
  }

  async dispose() {
    this.disposed = true;
    const jobs = [...this.jobs.values(), ...this.queries, ...(this.installation ? [this.installation] : [])];
    for (const job of jobs) { job.cancelled = true; if (job.child) killTree(job.child); }
    await this.ready;
    await Promise.allSettled(jobs.map(job => job.done));
    await Promise.allSettled(this.preparations.values());
  }
}
