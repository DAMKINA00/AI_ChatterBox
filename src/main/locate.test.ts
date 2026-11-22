import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { findCodex, findGrok } from "./locate";

type CodexFixture = {
  existing: Set<string>;
  directories: Map<string, string[]>;
  stats: Map<string, { mtimeMs: number; size: number }>;
  versions: Map<string, string | Error>;
};

function codexPaths(name: string) {
  const root = join(homedir(), `.chatterbox-locate-${name}`);
  const localAppData = join(root, "local");
  const codexHome = join(root, "home");
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  const standaloneExe = join(localAppData, "Programs", "OpenAI", "Codex", "bin", executable);
  const desktopRoot = join(localAppData, "OpenAI", "Codex", "bin");
  const desktopDir = join(desktopRoot, "desktop");
  const desktopExe = join(desktopDir, executable);
  const pathDir = join(root, "path");
  const pathExe = join(pathDir, executable);
  const releaseRoot = join(codexHome, "packages", "standalone", "releases");
  const releaseDir = join(releaseRoot, "standalone");
  const releaseExe = join(releaseDir, "bin", executable);
  return { localAppData, codexHome, standaloneExe, desktopRoot, desktopDir, desktopExe, pathDir, pathExe, releaseRoot, releaseDir, releaseExe };
}

function withCodexMocks<T>(fixture: CodexFixture, callback: (calls: { exists: any; readdir: any; stat: any; exec: any }) => T): T {
  const exists = mock.method(fs, "existsSync", (path) => fixture.existing.has(String(path)));
  const readdir = mock.method(fs, "readdirSync", (root) =>
    (fixture.directories.get(String(root)) ?? []).map((name) => ({ name, isDirectory: () => true })) as any,
  );
  const stat = mock.method(fs, "statSync", (path) => fixture.stats.get(String(path)) ?? { mtimeMs: 1, size: 1 });
  const exec = mock.method(childProcess, "execFileSync", (path) => {
    const result = fixture.versions.get(String(path));
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error(`No mocked version for ${String(path)}`);
    return result;
  });
  try {
    return callback({ exists, readdir, stat, exec });
  } finally {
    exec.mock.restore();
    stat.mock.restore();
    readdir.mock.restore();
    exists.mock.restore();
  }
}

function withCodexEnv<T>(paths: ReturnType<typeof codexPaths>, callback: () => T): T {
  const saved = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA, CODEX_HOME: process.env.CODEX_HOME };
  try {
    process.env.PATH = paths.pathDir;
    process.env.LOCALAPPDATA = paths.localAppData;
    process.env.CODEX_HOME = paths.codexHome;
    return callback();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function version(value: string): string {
  return `codex-cli ${value}`;
}

test("Codex discovery prefers a newer desktop copy over an older standalone CLI", () => {
  const paths = codexPaths("desktop-new");
  const fixture: CodexFixture = {
    existing: new Set([paths.standaloneExe, paths.desktopRoot, paths.desktopExe]),
    directories: new Map([[paths.desktopRoot, ["desktop"]]]),
    stats: new Map(),
    versions: new Map([[paths.desktopExe, version("0.200.0")], [paths.standaloneExe, version("0.164.0")]]),
  };
  withCodexEnv(paths, () => withCodexMocks(fixture, () => assert.equal(findCodex(), paths.desktopExe)));
});

test("Codex discovery prefers a newer PATH copy over a stale desktop cache", () => {
  const paths = codexPaths("path-new");
  const fixture: CodexFixture = {
    existing: new Set([paths.desktopRoot, paths.desktopExe, paths.pathExe]),
    directories: new Map([[paths.desktopRoot, ["desktop"]]]),
    stats: new Map(),
    versions: new Map([[paths.desktopExe, version("0.164.0")], [paths.pathExe, version("0.180.0")]]),
  };
  withCodexEnv(paths, () => withCodexMocks(fixture, () => assert.equal(findCodex(), paths.pathExe)));
});

test("Codex discovery ranks a stable release above a prerelease with the same core version", () => {
  const paths = codexPaths("stable");
  const fixture: CodexFixture = {
    existing: new Set([paths.desktopRoot, paths.desktopExe, paths.pathExe]),
    directories: new Map([[paths.desktopRoot, ["desktop"]]]),
    stats: new Map(),
    versions: new Map([[paths.desktopExe, version("1.2.3-beta.1")], [paths.pathExe, version("1.2.3")]]),
  };
  withCodexEnv(paths, () => withCodexMocks(fixture, () => assert.equal(findCodex(), paths.pathExe)));
});

test("Codex discovery compares numeric prerelease identifiers numerically", () => {
  const paths = codexPaths("numeric-prerelease");
  const fixture: CodexFixture = {
    existing: new Set([paths.desktopRoot, paths.desktopExe, paths.pathExe]),
    directories: new Map([[paths.desktopRoot, ["desktop"]]]),
    stats: new Map(),
    versions: new Map([[paths.desktopExe, version("1.2.3-alpha.3")], [paths.pathExe, version("1.2.3-alpha.13")]]),
  };
  withCodexEnv(paths, () => withCodexMocks(fixture, () => assert.equal(findCodex(), paths.pathExe)));
});

test("Codex discovery preserves an existing explicit override without probing candidates", () => {
  const paths = codexPaths("override");
  const override = join(paths.localAppData, "custom-codex.exe");
  const fixture: CodexFixture = {
    existing: new Set([override]),
    directories: new Map(),
    stats: new Map(),
    versions: new Map(),
  };
  withCodexEnv(paths, () => withCodexMocks(fixture, ({ readdir, stat, exec }) => {
    assert.equal(findCodex(override), override);
    assert.equal(readdir.mock.calls.length, 0);
    assert.equal(stat.mock.calls.length, 0);
    assert.equal(exec.mock.calls.length, 0);
  }));
});

test("Codex discovery caches a version probe until mtime or size changes", () => {
  const paths = codexPaths("cache");
  const fixture: CodexFixture = {
    existing: new Set([paths.pathExe]),
    directories: new Map(),
    stats: new Map([[paths.pathExe, { mtimeMs: 1, size: 10 }]]),
    versions: new Map([[paths.pathExe, version("1.0.0")]]),
  };
  withCodexEnv(paths, () => withCodexMocks(fixture, ({ exec }) => {
    assert.equal(findCodex(), paths.pathExe);
    assert.equal(findCodex(), paths.pathExe);
    assert.equal(exec.mock.calls.length, 1);
    const [probedPath, args, options] = exec.mock.calls[0].arguments as [string, string[], Record<string, unknown>];
    assert.equal(probedPath, paths.pathExe);
    assert.deepEqual(args, ["--version"]);
    assert.equal(options.encoding, "utf8");
    assert.equal(options.timeout, 3000);
    assert.equal(options.windowsHide, true);

    fixture.stats.set(paths.pathExe, { mtimeMs: 2, size: 10 });
    assert.equal(findCodex(), paths.pathExe);
    assert.equal(exec.mock.calls.length, 2);
    fixture.stats.set(paths.pathExe, { mtimeMs: 2, size: 20 });
    assert.equal(findCodex(), paths.pathExe);
    assert.equal(exec.mock.calls.length, 3);
  }));
});

test("Codex discovery falls back past a candidate with an invalid version", () => {
  const paths = codexPaths("invalid-version");
  const fixture: CodexFixture = {
    existing: new Set([paths.desktopRoot, paths.desktopExe, paths.pathExe]),
    directories: new Map([[paths.desktopRoot, ["desktop"]]]),
    stats: new Map(),
    versions: new Map([[paths.desktopExe, "not a codex version"], [paths.pathExe, version("0.164.0")]]),
  };
  withCodexEnv(paths, () => withCodexMocks(fixture, () => assert.equal(findCodex(), paths.pathExe)));
});

test("Codex discovery returns null when no candidates exist", () => {
  const paths = codexPaths("none");
  const fixture: CodexFixture = { existing: new Set(), directories: new Map(), stats: new Map(), versions: new Map() };
  withCodexEnv(paths, () => withCodexMocks(fixture, ({ exec }) => {
    assert.equal(findCodex(), null);
    assert.equal(exec.mock.calls.length, 0);
  }));
});

test("Grok discovery finds official native installation and respects explicit override", () => {
  const saved = { PATH: process.env.PATH, GROK_HOME: process.env.GROK_HOME };
  const native = join(homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
  const custom = join(homedir(), "custom-grok.exe");
  const exists = mock.method(fs, "existsSync", p => p === native || p === custom);
  try {
    process.env.PATH = ""; delete process.env.GROK_HOME;
    assert.equal(findGrok(), native);
    assert.equal(findGrok(custom), custom);
  } finally {
    exists.mock.restore();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
