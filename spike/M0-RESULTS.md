# M0 technical check: results

Date: 2026-10-12 · Machine: Windows 11 Home 10.0.26200 · Node v24.19.0 · tsx 4.23 / TypeScript 7.0

| Item | Result |
|---|---|
| Codex `app-server`: initialize, thread/start, 2 turns, streaming | **PASS** |
| Codex command approval request, answered `decline` | **PASS** (file not written; model reported DENIED) |
| Codex thread/resume from a new process (context kept) | **PASS** |
| Claude stream-json long-lived process: init / session_id / 2 turns on one stdin, text deltas | **PASS** |
| Claude `--resume <session_id>` from a new process (context kept) | **PASS** |
| Claude `--permission-prompt-tool` via local stdio MCP, answered deny | **PASS** (approver got the Write request, file not written, denial in `result.permission_denials`) |

All 7 Claude checks and all 6 Codex checks pass (second Claude run with the standalone CLI after login;
the first run with the desktop-bundled CLI failed with "Not logged in", see below).

Run: `cd spike && npm install && npm run codex` / `npm run claude`.
Raw JSONL of every run lands in `spike/.scratch/logs/` (git-ignored).

## CLI versions and discovery

- **Codex**: `codex-cli 0.162.0-alpha.17.2` from the Store app path
  `%LOCALAPPDATA%\OpenAI\Codex\bin\2e5e00daee91c61d\codex.exe`. Not on PATH.
  A second, older CLI also exists (`~\.codex\packages\standalone\releases\0.155.0-…\bin\codex.exe`).
  `findCodex()` in `common.ts` uses the same order as AIUsageMonitor `CodexAppServer.FindExecutable`
  (Store bin newest → PATH → `CODEX_HOME\packages\standalone\releases` newest). The Store `bin` folder can
  contain version folders without `codex.exe` (`9a7ba4b9ea0c44a3` here), so filter on file existence.
- **Claude Code**: standalone `2.1.296` at `%USERPROFILE%\.local\bin\claude.exe` (native installer
  `irm https://claude.ai/install.ps1 | iex`). The installer does **not** put `.local\bin` on the user PATH here,
  so the app must probe that path explicitly. `findClaude()`: `CLAUDE_EXE` env → PATH → `~\.local\bin\claude.exe`.
  - **Do not use the desktop app's private copy** (`%APPDATA%\Claude\claude-code\<ver>\<hash>\claude.exe`,
    2.1.281/2.1.295 at first). It is unstable (it was reported gone from that path later in the day, as app
    updates swap it) and it is **not logged in** when started outside the desktop app. The first spike run used
    it and every turn failed with `Not logged in · Please run /login`.
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
- Output event types seen (`type` / `subtype`):
  - `system/init`: `session_id`, `model` (`claude-opus-5-5`), `permissionMode:"default"`,
    `mcp_servers:[{name:"approver",status:"connected"}]`. Emitted again at the start of **every** turn.
  - `stream_event/*`: raw API stream: `message_start`, `content_block_start` (a `tool_use` block shows the tool
    name early), `content_block_delta` (`delta.type:"text_delta"` → streamed text), `content_block_stop`,
    `message_delta`, `message_stop`.
  - `assistant`: the complete message; `content[]` has `tool_use` blocks `{id,name,input}`.
  - `user`: `tool_result` blocks (`is_error:true` + the approver's message when denied).
  - `system/status`, `system/task_summary`, `system/post_turn_summary` (`status_category`, `status_detail`,
    `needs_action`; usable as a one-line turn summary).
  - `rate_limit_event`: `rate_limit_info {status, rateLimitType:"five_hour", resetsAt, unifiedWindows.five_hour.utilization}`.
    That's useful for a usage indicator.
  - `result/success`: `result`, `is_error`, `num_turns`, `total_cost_usd`, `usage`, `permission_denials[]`,
    `terminal_reason`.
- **Context carry-over**: `--resume <session_id>` in a new process kept the same `session_id` and answered
  the codeword from turn 1 (`파인애플-42`). The session lives in the CLI's project store for that `cwd`, so
  resume must use the same working directory.
- **Approval interception**: with `--permission-prompt-tool mcp__approver__approve` (tool name format
  `mcp__<server>__<tool>`), the Write tool call reached the MCP tool as
  `{tool_name:"Write", input:{file_path,content}, tool_use_id}`. The tool returned a text content block with
  JSON `{"behavior":"deny","message":"…"}`; Claude got a `tool_result` error with that message, replied
  `DENIED`, the file was not written, and `result.permission_denials` listed the call. Allow is
  `{"behavior":"allow","updatedInput":{…}}`. For the app, the MCP tool has to forward to the Electron UI and
  wait for the user (IPC from the MCP process back to the main process, e.g. a local named pipe/HTTP port).
- Closing stdin ends the process with exit code 0.
- `result` has `subtype:"success"` even for API errors (with `is_error:true`, `terminal_reason:"api_error"`), so
  **check `is_error` / `terminal_reason`, not `subtype`**.
- Cost: `total_cost_usd` was $0.316 after turn 1 (≈39.5k cache-creation tokens of system prompt on Opus),
  $0.401 after turn 2 in the same process (looks cumulative per process, so +$0.08), and $0.409 for the single
  turn of the resumed process (cache rebuilt on every new process). So keeping one process alive per
  conversation is noticeably cheaper than respawning per turn. On a subscription login the dollar figure is
  notional, but it maps to rate-limit usage.

First run (desktop-bundled CLI): every turn returned the synthetic assistant message
`Not logged in · Please run /login` (`error:"authentication_failed"`, `terminal_reason:"api_error"`).

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

1. **Require a standalone, logged-in Claude Code.** Locate `claude.exe` via a settings override, then PATH,
   then `%USERPROFILE%\.local\bin\claude.exe`. Never use the desktop app's private copy under
   `%APPDATA%\Claude\claude-code\…`: its path changes with app updates and it is not logged in on its own.
   Detect `authentication_failed` / `terminal_reason:"api_error"` on the first turn and show a
   "install / log in to Claude Code" state instead of a chat error.
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
