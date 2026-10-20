# DeepSeek character art

Generated on 2026-10-20 (KST) for the DeepSeek character asset set in
`src/renderer/public/characters/deepseek/`.

## Reference attribution and identity decision

- `docs/character-references/grok-user-reference.png` is the user-provided
  reference sheet screenshot. The visible sheet is titled `AI캐릭터종합콘`,
  credits `사슴뿔드래고니안`, and shows the date `2026.08.20`. The selected
  DeepSeek identity is the blue long-haired girl in the top-row second
  position and second-row first position. This reference supplied the blue
  hair, blue/white rectangular clips, and navy/white outfit direction.
- `src/renderer/public/characters/orch/neutral.png` supplied only the
  centered front-facing head-and-shoulders chibi framing, thick outlines,
  simple face, small bust, and transparent-margin style cues.
- The files in this document are newly generated artwork. They are not a
  copied crop or a claim of ownership of the reference sheet or its original
  character artwork. No licensing conclusion was made from the screenshot.

## Generation provenance

The built-in `image_gen` tool was used with `transparent_background=true`.
The CLI fallback, bitmap editing, code changes, and UI integration were not
used. The final neutral image was generated from both references, then each
expression was generated in a separate call using the saved neutral image as
the sole reference. The final selected source for `neutral.png` was:

`C:\Users\damki\.codex\generated_images\01a15737-2fd9-74e1-a2a4-7322f38344b7\exec-a4bdc9db-7266-4436-98f0-5058fba715b8.png`

An earlier neutral draft was generated but was not used because the later
neutral output gave the more consistent clips and outfit for the expression
set. The expression source files are recorded in the table below.

## Prompt set

The neutral prompt used the following normalized specification:

```text
Use case: stylized-concept. Asset type: transparent PNG character portrait.
Use the blue long-haired DeepSeek girl from the identity sheet and the
head-and-shoulders framing from orch/neutral.png. Create a centered,
front-facing chibi girl with long cobalt blue hair, small blue and white
rectangular clips on viewer-right, a navy high-neck dress, and a white collar
and bow. Use thick simple dark outlines, minimal pastel cel shading, a square
1254x1254 canvas when supported, and a genuinely transparent background with
the full hair silhouette inside a generous transparent margin. Keep a calm
neutral expression and small closed mouth. Use matte blue irises with no
white catchlights, sparkles, gloss, or iris gradients. Avoid hands, text,
logos, watermark, speech bubble, scenery, props, exposed shoulders, open
neckline, cleavage, photorealism, and detailed background.
```

Each expression prompt repeated these invariants: preserve the neutral
reference's identity, exact centered square framing, scale, crop, transparent
margin, hair silhouette, outfit, line art, colors, and lighting; change only
the facial expression; keep both hands absent; keep the background genuinely
transparent; and keep matte blue irises without white catchlights, sparkles,
gloss, or gradients. The expression-specific instruction was:

| Output | Expression instruction |
| --- | --- |
| `thinking.png` | Eyebrows slightly drawn together, eyes looking a little upward to viewer-left, small thoughtful closed mouth. |
| `speaking.png` | Calm open mouth with simple dark interior, relaxed brows, no pose change. |
| `happy.png` | Warm smile, closed crescent or curved cheerful eyes, soft raised brows. |
| `confident.png` | Half-lidded eyes, one slightly raised brow, small asymmetric closed smirk. |
| `surprised.png` | Wider eyes, lifted brows, small round open mouth. |
| `embarrassed.png` | Stronger cheek blush, shy slightly averted eyes, raised inner brows, tiny nervous closed mouth. |
| `worried.png` | Brows arched upward toward center, wide anxious eyes, small downturned or trembling closed mouth. |
| `sad.png` | Drooping lids, brows raised toward center, small downturned closed mouth, subtle cool cheek tone; no tears. |
| `angry.png` | Brows sharply angled down toward center, narrowed eyes, small firm frown, subtle warm cheek flush. |
| `tired.png` | Half-closed drooping eyes, relaxed low brows, tiny flat or slightly open weary mouth. |
| `waiting.png` | Eyes slightly toward viewer-left, mildly expectant raised brows, tiny neutral closed mouth. |

## Final outputs

All files were copied into the new directory
`src/renderer/public/characters/deepseek/`.

| File | Generated source | Size | Alpha check |
| --- | --- | --- | --- |
| `neutral.png` | `exec-a4bdc9db-7266-4436-98f0-5058fba715b8.png` | 1254x1254 | transparent and opaque pixels present |
| `thinking.png` | `exec-704575eb-9d6b-4d74-8286-cd0944fa1a72.png` | 1254x1254 | transparent and opaque pixels present |
| `speaking.png` | `exec-bde96d13-9689-45e4-b452-28e2b12f7851.png` | 1254x1254 | transparent and opaque pixels present |
| `happy.png` | `exec-432b5d35-03a8-4070-9086-44ce388ee695.png` | 1254x1254 | transparent and opaque pixels present |
| `confident.png` | `exec-ae22d800-a284-48f1-837b-04be2c50ee9c.png` | 1254x1254 | transparent and opaque pixels present |
| `surprised.png` | `exec-328cad0b-e917-4e6c-b5fe-5d6c3b2b7375.png` | 1254x1254 | transparent and opaque pixels present |
| `embarrassed.png` | `exec-b029a4e3-1647-4184-af27-746d089fc18e.png` | 1254x1254 | transparent and opaque pixels present |
| `worried.png` | `exec-e928d602-aacb-461f-ad8f-0550c2aa7839.png` | 1254x1254 | transparent and opaque pixels present |
| `sad.png` | `exec-62d01f1c-2564-4d25-a84c-7390c03c0318.png` | 1254x1254 | transparent and opaque pixels present |
| `angry.png` | `exec-d9a08a72-18f6-40f4-aceb-44eea1e6ca62.png` | 1254x1254 | transparent and opaque pixels present |
| `tired.png` | `exec-11c28cfd-4cdf-4c6b-8f83-d45f9c1fb1a1.png` | 1254x1254 | transparent and opaque pixels present |
| `waiting.png` | `exec-5fc730ed-b2cd-42c9-b72d-be8d3210ff26.png` | 1254x1254 | transparent and opaque pixels present |

## Verification

- All 12 requested files exist and are PNGs.
- Every output is 1254x1254 and therefore square.
- Every output contains transparent and opaque pixels. The final check used Electron nativeImage in scripts/verify-character-assets.mjs and did not modify any image.
- Every generated output was visually inspected before it was copied. Hair,
  clips, navy/white outfit, front-facing framing, and expression distinction
  were checked against the approved neutral reference.
- Renderer and gallery integration passed the DeepSeek UI and header tests. See deepseek.md for the final verification scope.
