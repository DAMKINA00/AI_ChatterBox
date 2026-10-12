# M0 technical check: results

Date: 2026-10-12 · Machine: Windows 11 Home 10.0.26200 · Node v24.19.0 · tsx 4.23 / TypeScript 7.0

| Item | Result |
|---|---|
| Codex `app-server`: initialize, thread/start, 2 turns, streaming | **PASS** |
| Codex command approval request, answered `decline` | **PASS** (file not written; model reported DENIED) |
| Codex thread/resume from a new process (context kept) | **PASS** |
| Claude stream-json long-lived process: init / session_id / 2 turns on one stdin | **Plumbing PASS**, model output **BLOCKED** (CLI not logged in) |
| Claude `--resume <session_id>` from a new process | **Plumbing PASS** (same session_id reported), context check **BLOCKED** (login) |
| Claude `--permission-prompt-tool` via local stdio MCP | MCP server connects (`status: connected`), call path **not yet exercised** (login) |

Run: `cd spike && npm install && npm run codex` / `npm run claude`.
Raw JSONL of every run lands in `spike/.scratch/logs/` (git-ignored).

## CLI versions and discovery

- **Codex**: `codex-cli 0.162.0-alpha.17.2` from the Store app path
  `%LOCALAPPDATA%\OpenAI\Codex\bin\2e5e00daee91c61d\codex.exe`. Not on PATH.
  A second, older CLI also exists (`~\.codex\packages\standalone\releases\0.155.0-…\bin\codex.exe`).
  `findCodex()` in `common.ts` uses the same order as AIUsageMonitor `CodexAppServer.FindExecutable`
  (Store bin newest → PATH → `CODEX_HOME\packages\standalone\releases` newest). The Store `bin` folder can
  contain version folders without `codex.exe` (`9a7ba4b9ea0c44a3` here), so filter on file existence.
- **Claude Code**: `2.1.295`. Not on PATH, no `~\.local\bin\claude.exe`, no npm global. The only copies
  are the ones the Claude desktop app keeps in `%APPDATA%\Claude\claude-code\<ver>\<hash>\claude.exe`
  (2.1.281 and 2.1.295 present). `findClaude()` picks the newest of those.
- `codex-schema/` is generated with `codex app-server generate-ts --out spike/codex-schema` (ts-rs output,
  743 files, `npm run codex:schema` regenerates). **The schema is tied to the CLI version**; the app should
  regenerate it per supported CLI version or code defensively against unknown methods/fields.

## Codex app-server: what was observed

Transport: newline-delimited JSON on stdio, JSON-RPC shape **without** the `"jsonrpc": "2.0"` field
(`{id, method, params}` / `{id, result}` / `{id, error}` / `{method, params}`).

Sequence that works:

1. `initialize` `{clientInfo:{name,title,version}, capabilities:{experimentalApi:false, requestAttestation:false}}`
   → `{userAgent, codexHome, platformFamily:"windows", platformOs:"windows"}`; then notification `initialized`.
2. `thread/start` `{cwd, approvalPolicy:"untrusted", sandbox:"read-only"}` → `{thread:{id,…}, model, sandbox:{type:"readOnly",networkAccess:false}, …}`.
   Thread ids are UUIDv7.
3. `turn/start` `{threadId, input:[{type:"text", text, text_elements:[]}]}` → `{turn:{id,…}}`; completion comes as notification.
4. `thread/resume` `{threadId, excludeTurns:true}` in a **new process** → same `thread.id`; the next turn
   answered the codeword from turn 1 correctly.
5. Closing stdin makes app-server exit with code 0 (no kill needed).

Notifications observed (per turn): `turn/started` → `item/started` / `item/completed` for items
`userMessage`, `reasoning`, `agentMessage`, `commandExecution` → `item/agentMessage/delta` (text deltas;
`params.delta`) → `turn/completed` (`turn.status`: `completed|interrupted|failed|inProgress`).
Others seen: `thread/started`, `thread/status/changed`, `thread/tokenUsage/updated`, `thread/goal/cleared`,
`account/rateLimits/updated`, `account/updated`, `mcpServer/startupStatus/updated`, `hook/started`,
`hook/completed`, `remoteControl/status/changed`, `serverRequest/resolved`, `configWarning`, `warning`.

Approval: server→client **request** `item/commandExecution/requestApproval` with
`{threadId, turnId, itemId, command, cwd, kind, commandActions, …}`. Reply `{id, result:{decision:"decline"}}`
(other values: `accept`, `acceptForSession`, `cancel`, `{acceptWithExecpolicyAmendment}`,
`{applyNetworkPolicyAmendment}`). The item then completes with `status:"declined"`, followed by
`serverRequest/resolved`. Other server requests to handle in the app: `item/fileChange/requestApproval`,
`item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`,
`item/tool/call`, plus legacy `execCommandApproval` / `applyPatchApproval`.

## Claude Code stream-json: what was observed

Command: `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
--mcp-config <file> --strict-mcp-config --permission-prompt-tool mcp__approver__approve [--resume <id>]`.
`--dangerously-skip-permissions` is not used.

- Input lines: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`.
  One process accepted two turns on the same stdin; each turn produced its own `system/init` (same
  `session_id`) and its own `result` event.
- Output event types seen: `system/init` (`session_id`, `model`, `permissionMode:"default"`,
  `mcp_servers:[{name:"approver",status:"connected"}]`), `system/status`, `assistant`, `result/success`.
  With a working login, `stream_event/*` (`content_block_delta` + `text_delta`), `assistant` `tool_use`
  blocks and `user` `tool_result` blocks are expected too; `claude-stream.ts` already handles them.
- `--resume <session_id>` in a new process reported the same `session_id`.
- Closing stdin ends the process (exit code 1 here, because every turn was an API error).
- The `result` event carries `permission_denials`, `terminal_reason`, `total_cost_usd`, `num_turns`,
  `is_error`. Note `subtype:"success"` together with `is_error:true` for API errors, so **check `is_error` and
  `terminal_reason`, not `subtype`**.

**Blocker:** every turn returned the synthetic assistant message `Not logged in · Please run /login`
(`error:"authentication_failed"`, `terminal_reason:"api_error"`). The desktop-bundled CLI has no login of
its own when it is started outside the desktop app. Fix: log in once with that exe (`claude.exe` → `/login`)
or install standalone Claude Code and log in, then re-run `npm run claude`.

## Windows-specific notes

- **Encoding**: Korean text round-tripped correctly both ways (`파인애플-42`, `확인`) when stdin is written as
  UTF-8 and stdout is decoded with `setEncoding("utf8")`. Do not rely on the console code page.
- **Codex shell is PowerShell**: the command shown in approvals is
  `"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'echo hi > note.txt'`. The UI should
  display `commandActions` or strip the wrapper for readability.
- **Process kill**: `ChildProcess.kill()` only kills the direct child on Windows; Codex/Claude spawn MCP
  servers and shells. `common.ts` `killTree()` uses `taskkill /PID <pid> /T /F`. In the normal path both CLIs
  exit cleanly on stdin EOF, so use EOF first and taskkill as fallback.
- **Spawning**: spawn the `.exe` directly (no shell). For the MCP server I run the current `node.exe` with
  `node_modules/tsx/dist/cli.mjs` to avoid `.cmd` shims, which need `shell:true` on Windows.
- **Paths**: Codex accepts Windows paths in `cwd` and returns them as-is (`D:\Photo\…`).
- npm 11 blocks dependency install scripts by default (`allow-scripts` warning for esbuild); tsx still works
  because esbuild ships the platform binary as an optional package.

## Things that affect the design

1. **Claude auth is not guaranteed.** The app must detect `authentication_failed` / `terminal_reason:"api_error"`
   on the first turn and show a "log in to Claude Code" state instead of a chat error. It also must locate
   the CLI under `%APPDATA%\Claude\claude-code\…` when it is not on PATH, and that copy may not be logged in.
2. **User config bleeds into Codex sessions.** app-server loads the user's `~\.codex\config.toml`, plugins,
   hooks (`hook/started` for a `ponytail` plugin's sessionStart/userPromptSubmit) and MCP servers
   (`codex_apps`, `cua_repl`, `node_repl`). Threads are stored in the user's `CODEX_HOME`, so they will also
   show in the Codex app's history. Decide whether that is wanted or whether to use a separate `CODEX_HOME`
   (which would need its own login). Claude has the same issue unless `--strict-mcp-config` /
   `--setting-sources` are used.
3. **Protocol is version-specific and large** (Codex 0.162 alpha has ~100 client methods and ~90
   notifications). Plan for a thin adapter that handles the core set listed above and logs and ignores the rest.
4. Unhandled server requests must still get a reply (the spike replies with JSON-RPC error `-32601`), or the
   turn blocks.
