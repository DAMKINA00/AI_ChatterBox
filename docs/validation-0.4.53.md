# v0.4.53 — independent CLI login status and compact model names

Opening a model menu previously replaced the provider list with installation-only results, dropping verified login states. Installation refresh now preserves each unchanged executable's authentication. Provider refresh requests are scoped, initial checks publish independently, and one account's login/logout no longer invalidates other accounts' auth or Antigravity model caches.

Antigravity login now rechecks only the account whose console closed. A successful console exit alone does not count as authentication: the account's native read-only login check must pass. Failed or unconfirmed completion leaves an error on that account card. While the account dialog is open, the selected login is also polled and shows its own waiting state. Deleted and recreated account IDs cannot accept an old console's completion. The Antigravity account-management link opens its own provider tab.

The existing `agy acp --login` flow and isolated per-account HOME/USERPROFILE credentials are retained. The dialog explains the required code/full-URL exchange. Browser completion and code entry were reported by the user; missing code entry is not the established cause of their failure. Real Google sign-in for account 2 still requires manual validation on the installed app.

Model names omit the redundant `Gemini `, `GPT-`, and `DeepSeek ` prefixes for display. Grok names, model IDs, saved settings and provider requests remain unchanged.

Validation on Windows x64:

- Node and renderer TypeScript checks passed.
- Unit tests: 712/712, including CLI snapshot merging, scoped auth/cache changes, console success/failure, recreated-account isolation and shortened labels.
- Account browser UI: 62 checks, including installation-only refresh, targeted and slow authentication, added-account automatic confirmation, compact labels and exact stored IDs.
- Isolated Electron Antigravity availability: 15/15.
- Existing provider Electron UI: 22/22.
- No real model prompt was sent. Native `agy acp --login` was inspected in a disposable isolated profile without completing Google authentication; authorization URLs were redacted.
- Usage monitor pin remains `fb9488bee265577560ed5681a40f9f5b8571f390`.
