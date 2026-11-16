# v0.4.52 — Antigravity installation availability

When `agy` is missing, Antigravity is disabled in worker model and reasoning controls and is unavailable as a new master selection. A chat already configured with an Antigravity master retains its draft and settings but cannot start or resume work until the CLI is detected or a different master is selected. Other providers remain usable.

Installation recheck refreshes availability and clears stale Gemini model results. Installing or removing the CLI changes availability without rewriting saved model choices, worker limits or account preferences. Team capabilities also report Antigravity as disabled when the CLI is absent; the existing worker spawn check rejects unavailable CLI workers.

Validation on Windows x64:

- Node and renderer TypeScript checks passed.
- Unit tests: 707/707 passed, including missing/present/removed CLI capabilities and worker spawn rejection.
- Isolated Electron availability UI: 15/15 passed, including blocked Enter, preserved drafts, other-provider selection, installation recovery and cached-model invalidation.
- Existing provider UI: 22/22 passed.
- Bundled usage monitor remains pinned to `fb9488bee265577560ed5681a40f9f5b8571f390`; its regression and hosted protocol checks passed 480/480 and 64/64 respectively.

UI tests use isolated data and fixture IPC; they never send a real model prompt or alter the installed CLI. The legacy provider migration fixture now supplies its own unused driver path rather than requiring a real Antigravity installation.

For deployment on the validation PC, the official Windows x64 Antigravity 1.5.9 binary was verified against the updater manifest SHA-512 and installed at `%LOCALAPPDATA%/agy/bin/agy.exe`. `agy --version` and shell command discovery passed. Google authentication and a live model turn were not exercised.
