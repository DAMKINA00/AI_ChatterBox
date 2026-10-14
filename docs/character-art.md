# Character art assets

This document records the generated character art used by the desktop chat UI.

## Delivered files

The final asset set contains four characters and twelve expressions per character (48 PNG files). Gemini's dedicated generation record is in [`docs/gemini-character-art.md`](gemini-character-art.md):

- `src/renderer/public/characters/orch/{neutral,thinking,speaking,happy,confident,surprised,embarrassed,worried,sad,angry,tired,waiting}.png`
- `src/renderer/public/characters/claude/{neutral,thinking,speaking,happy,confident,surprised,embarrassed,worried,sad,angry,tired,waiting}.png`
- `src/renderer/public/characters/gpt/{neutral,thinking,speaking,happy,confident,surprised,embarrassed,worried,sad,angry,tired,waiting}.png`
- `src/renderer/public/characters/gemini/{neutral,thinking,speaking,happy,confident,surprised,embarrassed,worried,sad,angry,tired,waiting}.png`

All files are front-facing head-and-shoulders chibi portraits on a square canvas with genuine RGBA transparency. The visual system is shared across all four roles: a thick dark outline, large simple chibi proportions, restrained pastel cel shading, minimal interior detail, and matte flat-color irises. The irises contain no white catchlights, sparkle, gloss, shine, reflective dots, or gradients.

## Character references

The original reference files and their project copies are:

| Role | Original reference | Project copy |
| --- | --- | --- |
| Orch | `C:\Users\damki\AppData\Local\Temp\codex-clipboard-5168011c-c44c-4895-aadc-8557ad707843.png` | `docs/character-references/orch-source.png` |
| Claude | `C:\Apps\AIUsageMonitor\art\ref\claude.png` | `docs/character-references/claude-source.png` |
| GPT | `C:\Apps\AIUsageMonitor\art\ref\codex.png` | `docs/character-references/gpt-source.png` |
| Gemini | User-attached reference and downloaded source | `docs/character-references/gemini-user-reference.png`, `docs/character-references/gemini-source.png` |

The identity cues preserved in the final files are:

- Orch: apricot hair, green eyes, white doctor/lab coat, and pale pink shirt.
- Claude: long brown hair, glasses, black ribbon with a gold star, and black/gold clothing with a white ruffled collar.
- GPT: white bob haircut, cyan eyes, cyan triangle hairpin, and a white/cyan hoodie.
- Gemini: blonde twin-tails with pink-to-magenta tips, teal ribbons, matte blue eyes, blue-and-yellow star hairpin, white shirt, and navy vest.

The finished `src/renderer/public/characters/orch/neutral.png` was also used as the master style reference while rebuilding the Claude and GPT neutral bases. Gemini's neutral base was generated separately from the user-confirmed Gemini reference, and its eleven expression variants were generated from that neutral. The current character neutral references were supplied at the same time so identity accessories and clothing remained intact. All expression variants were then generated from the corresponding finished neutral base.

## Generation record

Tool: built-in `image_gen.imagegen` with `transparent_background: true`. Each asset/variant used one independent image generation call. The generated source was read from the tool's returned `output_hint` path and copied into the final project asset path. No API, CSS drawing, vector replacement, or hand-edited bitmap was used. Gemini's neutral and expression details are recorded in [`docs/gemini-character-art.md`](gemini-character-art.md).

The exact expression prompt template passed to each non-neutral expression call was:

```text
Use case: ui-mockup
Asset type: transparent chibi character face/bust icon for a desktop chat UI
Primary request: Create the {expression} expression variant from the attached finished neutral character base. Preserve identity and the same simplified master chibi style while changing only the expression: {expression detail}.
Input images: Image 1 is the finished neutral identity and style reference for {character}; preserve {identity cues}.
Scene/backdrop: genuinely transparent alpha background, no environment.
Subject: one centered front-facing head-and-shoulders chibi portrait.
Style/medium: same thick simple dark outline, large simple chibi face, restrained pastel cel shading, minimal interior detail, matching the attached neutral.
Composition/framing: match the neutral square canvas, centered bust, same scale and transparent padding.
Lighting/mood: soft even light without eye reflections.
Color palette: match the neutral base.
Constraints: keep hair, eyes, glasses or hair accessory, clothing, crop, outline weight, and transparent alpha. Irises must be matte flat single-color fills in existing eye color; absolutely no white catchlights, sparkle, gloss, shine, reflective dots, or iris gradients. Show {expression} only via {expression detail}; no background, text, frame, watermark, or extra characters; readable at 24-36 px.
Avoid: thin detailed anime linework, glossy/sparkling eyes, redesign, changed accessories/clothes, full body, side profile, realism, scenery, symbols, borders, opaque background.
```

The eleven non-neutral `{expression detail}` substitutions were:

| Expression | Detail |
| --- | --- |
| `thinking` | one eyebrow raised, eyes upward, thoughtful mouth, minimal hand near chin |
| `speaking` | small open talking mouth, one hand near the chest, no speech bubble or text |
| `happy` | cheerful open smile, lifted cheeks, soft rosy blush, simple happy eyelids or matte irises only |
| `confident` | steady eyes, slightly lifted chin, raised brow, knowing smile |
| `surprised` | wide matte eyes, raised eyebrows, tiny O mouth |
| `embarrassed` | averted gaze, rosy blush, nervous closed smile |
| `worried` | knit brows, uncertain wide eyes, downturned mouth |
| `sad` | drooping eyelids and brows, downturned mouth, gentle tearful sadness |
| `angry` | lowered brows, narrowed eyes, tense frown, no flames or symbols |
| `tired` | half-lidded sleepy eyes, drooping brows, weary mouth, subtle under-eye shading |
| `waiting` | patient expectant expression, gaze slightly to one side, small hopeful closed mouth, calm waiting mood |

Neutral bases were generated first with the same transparent chibi asset constraints and matte-eye rule. Claude and GPT neutral rebuilds used two references: the character's existing neutral for identity and the finished Orch neutral for the thick-outline, simple-face, minimal-shading master style. Gemini's neutral base was generated from the user-confirmed Gemini reference; its exact neutral prompt is recorded separately in `docs/gemini-character-art.md`. The neutral instruction was to preserve each character's identifying hair, eyes, accessory, clothing, crop, and palette while matching the master neutral's thick simple outline, large simple face, minimal pastel cel shading, and matte flat-color irises. The four neutral files are the bases used by all subsequent variants.

## Validation

On 2026-10-14, the final project directory was checked with Pillow:

- 48 expected files present; 0 missing.
- All 48 files decode as `RGBA`.
- All 48 files contain transparent pixels (`alpha` extrema include 0) and opaque subject pixels (`alpha` extrema include 255).
- All 48 files are `1254 x 1254` pixels.
- The generated image outputs were visually inspected during each batch for the shared outline, chibi crop, matte eyes, preserved identity cues, and transparent background.

Only the character asset paths, this record, and the reference copies are part of this asset-production scope; application code was not edited by the asset generation work.
