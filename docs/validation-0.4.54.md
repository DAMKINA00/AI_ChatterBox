# v0.4.54 — separate Antigravity models and reasoning

The Antigravity CLI catalogue exposes effort-suffixed IDs, which the app previously showed as separate model choices. The model picker now groups these IDs into one entry per model family, retaining the selected native ID or preferring the family's default/medium entry. Display names omit `(Medium)`, `(High)` and other effort suffixes. Reasoning remains in its own picker, using all levels reported by the CLI for the selected family.

Native model metadata and execution mapping remain intact: the Gemini driver still resolves a selected reasoning level to the corresponding supported native variant. Saved selections are preserved, unavailable saved models remain visible, and exact native IDs are available in model-item tooltips. Other providers' model grouping is unchanged.

This release includes v0.4.53's independent provider/account authentication, per-account Antigravity console completion check and failure feedback, and shortened Gemini/GPT/DeepSeek display names.

Validation on Windows x64:

- Node and renderer TypeScript checks passed.
- Unit tests: 714/714.
- Account browser UI: 65 checks, including a single model choice for Gemini effort variants, separate reasoning selection and unchanged stored IDs.
- Antigravity availability Electron UI: 15/15.
- Provider Electron UI: 22/22.
- No real model prompt was sent. Live Google sign-in for the user's second Antigravity account requires manual verification after installation.
- Usage monitor pin remains `fb9488bee265577560ed5681a40f9f5b8571f390`.
