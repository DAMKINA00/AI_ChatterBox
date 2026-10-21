import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { GRAPHIFY_VERSION } from "../shared/graphify";
import { GraphifyService, graphSource, parseGraph } from "./graphify";

const schema = (graphify_version?: unknown) => ({
  schema_version: 1,
  ...(graphify_version === undefined ? {} : { graphify_version }),
});

test("first project analysis waits, deduplicates and reuses the saved graph", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-graph-prepare-"));
  const project = { id: 1, folder: root } as any;
  const service = new GraphifyService(join(root, "data"));
  const internal = service as any;
  let installs = 0, builds = 0, finish!: () => void;
  internal.install = async () => { installs++; internal.installed = true; };
  internal.build = async (key: string, path: string) => {
    builds++;
    await new Promise<void>(resolve => { finish = resolve; });
    internal.snapshots.set(key, { folder: root, graph: parseGraph({ graph: schema(), nodes: [], links: [] }, path, 123) });
  };
  try {
    let returned = false;
    const first = service.prepare(project).then(result => { returned = true; return result; });
    const second = service.prepare(project);
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, false);
    finish();
    const results = await Promise.all([first, second]);
    assert.equal(installs, 1);
    assert.equal(builds, 1);
    assert.equal(results[0].graph?.generatedAt, 123);
    assert.equal(results[1].graph?.generatedAt, 123);
    assert.equal((await service.prepare(project)).graph?.generatedAt, 123);
    assert.equal(builds, 1, "existing analysis is reused even for an empty source graph");
  } finally { await service.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("failed first analysis propagates the error and can be retried", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-graph-failed-"));
  const service = new GraphifyService(join(root, "data"));
  const internal = service as any;
  internal.installed = true;
  internal.build = async () => { throw new Error("extraction failed"); };
  try {
    for (let i = 0; i < 2; i++) await assert.rejects(service.prepare({ id: 1, folder: root } as any), /extraction failed/);
  } finally { await service.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("parseGraph validates the schema and maps links, node fields, and metadata", () => {
  const graph = parseGraph({
    graph: schema("reference-version"),
    nodes: [
      {
        id: "a",
        label: "Alpha",
        type: "function",
        source_file: "src/a.ts",
        source_location: "L12:4",
        community: 2,
        description: "entry point",
      },
      {
        id: "b",
        label: "",
        file_type: "class",
        source_file: "src/b.ts",
        source_location: "unknown",
        community: null,
        description: 123,
      },
      { id: "c", source_file: "src/c.ts" },
    ],
    links: [
      { source: "a", target: "b", relation: "calls", confidence: "HIGH" },
      { source: "b", target: "b" },
    ],
  }, "C:/project", 1234);

  assert.equal(graph.root, "C:/project");
  assert.equal(graph.generatedAt, 1234);
  assert.equal(graph.version, "reference-version");
  assert.deepEqual(graph.nodes, [
    {
      id: "a",
      label: "Alpha",
      kind: "function",
      sourceFile: "src/a.ts",
      line: 12,
      community: "2",
      description: "entry point",
      degree: 1,
    },
    {
      id: "b",
      label: "b",
      kind: "class",
      sourceFile: "src/b.ts",
      line: undefined,
      community: "0",
      description: "",
      degree: 3,
    },
    {
      id: "c",
      label: "c",
      kind: "code",
      sourceFile: "src/c.ts",
      line: undefined,
      community: "0",
      description: "",
      degree: 0,
    },
  ]);
  assert.deepEqual(graph.edges, [
    { source: "a", target: "b", relation: "calls", confidence: "HIGH" },
    { source: "b", target: "b", relation: "related", confidence: "UNKNOWN" },
  ]);
});

test("parseGraph accepts the edges alias and falls back to the current Graphify version", () => {
  const graph = parseGraph({
    graph: schema(),
    nodes: [{ id: "from" }, { id: "to" }],
    edges: [{ source: "from", target: "to" }],
  }, "root", 7);

  assert.equal(graph.version, GRAPHIFY_VERSION);
  assert.deepEqual(graph.edges, [{ source: "from", target: "to", relation: "related", confidence: "UNKNOWN" }]);
  assert.equal(graph.nodes[0].degree, 1);
  assert.equal(graph.nodes[1].degree, 1);
});

test("parseGraph rejects unsupported schemas, missing or duplicate IDs, and unknown endpoints", () => {
  const root = "root";
  assert.throws(() => parseGraph(null, root, 0), /지원하지 않는 Graphify 그래프 형식/);
  assert.throws(() => parseGraph({ nodes: [], links: [], graph: { schema_version: 2 } }, root, 0), /지원하지 않는 Graphify 그래프 형식/);
  assert.throws(() => parseGraph({ nodes: [], links: "bad", graph: schema() }, root, 0), /지원하지 않는 Graphify 그래프 형식/);

  const duplicate = { graph: schema(), nodes: [{ id: "same" }, { id: "same" }], links: [] };
  assert.throws(() => parseGraph(duplicate, root, 0), /노드 ID가 없거나 중복/);

  const missing = { graph: schema(), nodes: [{ id: "" }], links: [] };
  assert.throws(() => parseGraph(missing, root, 0), /노드 ID가 없거나 중복/);

  const unknownEndpoint = { graph: schema(), nodes: [{ id: "known" }], links: [{ source: "known", target: "missing" }] };
  assert.throws(() => parseGraph(unknownEndpoint, root, 0), /그래프 연결의 노드를 찾을 수/);
});

test("parseGraph preserves hostile text while applying field limits and safe defaults", () => {
  const controlText = "<script>\u0000\nline</script>";
  const hostileId = `node-${controlText}`;
  const longSource = "s".repeat(2_500);
  const longDescription = "d".repeat(9_000);
  const graph = parseGraph({
    graph: { schema_version: 1, graphify_version: null },
    nodes: [
      {
        id: hostileId,
        label: controlText,
        type: 42,
        source_file: longSource,
        source_location: "L42:1 trailing text",
        description: longDescription,
      },
      {
        id: "target",
        label: null,
        file_type: "module",
        community: false,
        description: controlText,
      },
    ],
    links: [{ source: hostileId, target: "target", relation: controlText, confidence: 42 }],
  }, "root", 0);

  assert.equal(graph.version, GRAPHIFY_VERSION);
  assert.equal(graph.nodes[0].id, hostileId);
  assert.equal(graph.nodes[0].label, controlText);
  assert.equal(graph.nodes[0].kind, "code");
  assert.equal(graph.nodes[0].sourceFile, longSource.slice(0, 2_000));
  assert.equal(graph.nodes[0].line, 42);
  assert.equal(graph.nodes[0].description, longDescription.slice(0, 8_000));
  assert.equal(graph.nodes[1].label, "target");
  assert.equal(graph.nodes[1].kind, "module");
  assert.equal(graph.nodes[1].community, "false");
  assert.equal(graph.nodes[1].description, controlText);
  assert.deepEqual(graph.edges, [{ source: hostileId, target: "target", relation: controlText, confidence: "UNKNOWN" }]);
});

test("graphSource resolves a regular file inside the project and rejects directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "aichatterbox-graphify-source-"));
  try {
    mkdirSync(join(root, "src"));
    const file = join(root, "src", "feature.ts");
    writeFileSync(file, "export const feature = true;\n");

    assert.equal(await graphSource(root, "src/feature.ts"), await realpath(file));
    await assert.rejects(() => graphSource(root, "src"), /프로젝트 외부 소스는 열 수 없습니다/);
    await assert.rejects(() => graphSource(root, "."), /프로젝트 외부 소스는 열 수 없습니다/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graphSource rejects traversal and absolute source paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "aichatterbox-graphify-source-root-"));
  const outside = mkdtempSync(join(tmpdir(), "aichatterbox-graphify-source-outside-"));
  try {
    const outsideFile = join(outside, "outside.ts");
    writeFileSync(outsideFile, "export const outside = true;\n");
    const traversal = relative(resolve(root), resolve(outsideFile));

    assert.ok(traversal === ".." || traversal.startsWith(`..${sep}`));
    await assert.rejects(() => graphSource(root, traversal), /프로젝트 외부 소스는 열 수 없습니다/);
    await assert.rejects(() => graphSource(root, outsideFile), /프로젝트 외부 소스는 열 수 없습니다/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("graphSource rejects a symlink that resolves outside the project when the OS permits symlinks", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aichatterbox-graphify-symlink-root-"));
  const outside = mkdtempSync(join(tmpdir(), "aichatterbox-graphify-symlink-outside-"));
  try {
    const outsideFile = join(outside, "outside.ts");
    const link = join(root, "linked.ts");
    writeFileSync(outsideFile, "export const outside = true;\n");
    try {
      symlinkSync(outsideFile, link, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && ["EACCES", "EPERM", "ENOTSUP", "UNKNOWN"].includes(code ?? "")) {
        t.skip(`symbolic links unavailable (${code ?? "unknown error"})`);
        return;
      }
      throw error;
    }

    await assert.rejects(() => graphSource(root, "linked.ts"), /프로젝트 외부 소스는 열 수 없습니다/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
