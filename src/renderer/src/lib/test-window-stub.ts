// Test-only: lets renderer components be imported and rendered in Node for server-side rendering checks.
// Import it before the component under test.
//  - window.chatterbox is read by lib/utils at load time.
//  - The official unit runner (scripts/test-unit.mjs) bundles with esbuild's classic JSX runtime, which
//    compiles JSX to React.createElement and needs React as a global (same as cli-accounts-ui.test.ts).
import * as React from "react";

const g = globalThis as unknown as { React?: unknown; window?: { chatterbox?: unknown } };
g.React ??= React;
g.window ??= {};
g.window.chatterbox ??= new Proxy({}, { get: () => () => Promise.resolve(undefined) });
export {};
