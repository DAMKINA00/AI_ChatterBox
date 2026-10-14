# Administrator character

Generated 2026-10-14 with the built-in `image_gen.imagegen` tool, `transparent_background: true`.

- Final asset: `src/renderer/public/characters/admin/neutral.png` (1254 × 1254 PNG).
- Source: `C:\Users\damki\.codex\generated_images\01a1336d-1d77-78c2-8456-fbce98edb48c\exec-1311b32f-10d4-4774-9eb5-79bba1af2131.png`; copied without modifying the bitmap.
- Style references: `src/renderer/public/characters/orch/neutral.png` and `src/renderer/public/characters/gpt/neutral.png`.
- Identity: short navy hair, matte lavender eyes, gray hoodie, small gold shield pin; a new fictional administrator, distinct from model characters.
- One neutral portrait for human messages. Display name is `관리자`; stored user event roles are unchanged, including earlier chats.
- Alpha and dimensions checked with `node scripts/verify-character-assets.mjs --no-preview`: all 49 assets decode at 1254 × 1254 and contain transparent and opaque pixels.

## Exact generation prompt

```text
Create one original administrator avatar for a desktop AI chat app by reimagining the supplied style-reference portraits as a new, distinct fictional character. References are style references only: use their bold dark brown outlines, very simple large chibi head and small shoulders, restrained soft pastel cel shading, calm half-lidded eyes, and square centered head-and-shoulders composition. New character identity: friendly competent androgynous administrator with short softly tousled dark navy-blue hair (clearly shorter than the references), matte flat lavender irises, a tiny relaxed closed smile, a light gray zip hoodie over a muted lavender shirt, and one small simple gold shield-shaped pin on the hoodie. No glasses, lab coat, hair bow, headset, crown, or props. The neutral face should be very readable as a 36px avatar and fit well with the attached character set, with the face occupying most of the image and a little clear padding around hair and shoulders. Eyes must have no sparkle, gloss, white catchlights, reflection spots, or iris gradients; pure flat muted lavender irises. One centered front-facing bust only on a genuinely transparent alpha background, square canvas, clean finished illustration. No words, letters, labels, watermark, border, background shapes, multiple poses, scenery, full body, or extra characters. Preserve the style of the references while making this visibly a new administrator character.
```
