# Grok character art

Generated with the built-in ImageGen tool, with transparent_background enabled. No CLI/API fallback or bitmap edits were used.

Reference: user-provided screenshot of AI캐릭터종합콘, credited in the screenshot to 사슴뿔드래고니안 (2026.08.20). The user identified Grok in that sheet. Reference copy: [grok-user-reference.png](character-references/grok-user-reference.png).

Identity: long loose blonde hair, black square X hair clip, matte gray-blue eyes, black jacket and high-neck shirt. The app's Orch neutral is the style reference. Output: twelve square RGBA portraits under src/renderer/public/characters/grok/.

## Neutral prompt

```text
Use case: ui-mockup
Asset type: transparent chibi avatar for the AI_ChatterBox desktop chat UI.
Primary request: Create ONE new neutral Grok character portrait, based on the blonde Grok character with black X hair clip in reference image 1, rendered in the simplified existing app style of image 2. Do not reproduce the screenshot or the sticker sheet.
Input images: Image 1 is the user's meme character reference screenshot; Grok is the LONG BLONDE-HAIRED character wearing BLACK with a BLACK SQUARE HAIR CLIP with a WHITE X (first sticker top left; also second row fifth). Image 2 is the existing app's Orch neutral STYLE AND FRAMING reference only; do not copy its hair, clothing, eye color or ribbons.
Subject: one front-facing head-and-shoulders chibi girl with long loose warm blonde hair, side-swept bangs, small black square hair clip with white X on viewer right, matte desaturated gray-blue eyes, a plain black jacket with a tiny white X accent and black high-neck inner shirt. Modest closed clothing, no cleavage. Calm slightly cheeky half-lidded neutral expression, subtle closed smile. No hands.
Style: Match image 2: thick simple dark outline, large simple face, tiny bust, restrained pastel cel shading, minimal interior detail. Flat single-color matte irises with NO white catchlights, sparkle, gloss, reflective dots, or iris gradients.
Composition: centered square 1254 x 1254 canvas if possible, head and shoulders filling the same scale as reference 2, a small transparent margin around all hair, complete head and bust silhouette.
Background: real transparent RGBA alpha, no scenery, shadow, text, captions, speech bubbles, watermark, frame, or extra characters.
Avoid: sticker slogans, copying the entire reference sheet, ribbons, twin tails, glasses, detailed anime rendering, shiny eyes, full body. Preserve the blonde/black/X Grok identity distinct from Gemini.
```

## Expression prompts

### thinking

```text
Use case: ui-mockup
Create ONE thinking expression variant of the attached finished Grok neutral avatar for a desktop chat app.
The input is the identity, style and framing reference. Preserve exactly the long loose warm blonde hair, black square clip with white X on viewer right, matte gray-blue eyes, black jacket with small white X, black high-neck shirt, thick simple dark outlines, large simple chibi face and tiny bust.
Change only the expression to: one eyebrow raised, eyes looking upward, thoughtful closed mouth, one small hand near chin.
Front-facing centered head-and-shoulders crop, same square canvas and scale, keep entire hair and bust silhouette inside transparent padding. Restraint in pastel cel shading and interior detail; readable at 24-36 pixels.
Eyes have flat single-color matte irises; NO white catchlights, sparkle, shine, gloss, reflective dots or iris gradients.
True transparent RGBA background. No text, slogans, frame, watermark, scenery, extra characters, redesign, new accessories, glossy anime details, full body or side profile.
```

### speaking

```text
Use case: ui-mockup
Create ONE speaking expression variant of the attached finished Grok neutral avatar for a desktop chat app.
The input is the identity, style and framing reference. Preserve exactly the long loose warm blonde hair, black square clip with white X on viewer right, matte gray-blue eyes, black jacket with small white X, black high-neck shirt, thick simple dark outlines, large simple chibi face and tiny bust.
Change only the expression to: small open talking mouth, one small hand near chest, no speech bubble.
Front-facing centered head-and-shoulders crop, same square canvas and scale, keep entire hair and bust silhouette inside transparent padding. Restraint in pastel cel shading and interior detail; readable at 24-36 pixels.
Eyes have flat single-color matte irises; NO white catchlights, sparkle, shine, gloss, reflective dots or iris gradients.
True transparent RGBA background. No text, slogans, frame, watermark, scenery, extra characters, redesign, new accessories, glossy anime details, full body or side profile.
```

### happy

```text
Use case: ui-mockup
Create ONE happy expression variant of the attached finished Grok neutral avatar for a desktop chat app.
The input is the identity, style and framing reference. Preserve exactly the long loose warm blonde hair, black square clip with white X on viewer right, matte gray-blue eyes, black jacket with small white X, black high-neck shirt, thick simple dark outlines, large simple chibi face and tiny bust.
Change only the expression to: cheerful open smile, lifted cheeks, subtle rosy blush.
Front-facing centered head-and-shoulders crop, same square canvas and scale, keep entire hair and bust silhouette inside transparent padding. Restraint in pastel cel shading and interior detail; readable at 24-36 pixels.
Eyes have flat single-color matte irises; NO white catchlights, sparkle, shine, gloss, reflective dots or iris gradients.
True transparent RGBA background. No text, slogans, frame, watermark, scenery, extra characters, redesign, new accessories, glossy anime details, full body or side profile.
```

### confident

```text
Use case: ui-mockup
Create ONE confident expression variant of the attached finished Grok neutral avatar for a desktop chat app.
The input is the identity, style and framing reference. Preserve exactly the long loose warm blonde hair, black square clip with white X on viewer right, matte gray-blue eyes, black jacket with small white X, black high-neck shirt, thick simple dark outlines, large simple chibi face and tiny bust.
Change only the expression to: steady half-lidded eyes, slightly lifted chin, raised brow and cheeky knowing smile.
Front-facing centered head-and-shoulders crop, same square canvas and scale, keep entire hair and bust silhouette inside transparent padding. Restraint in pastel cel shading and interior detail; readable at 24-36 pixels.
Eyes have flat single-color matte irises; NO white catchlights, sparkle, shine, gloss, reflective dots or iris gradients.
True transparent RGBA background. No text, slogans, frame, watermark, scenery, extra characters, redesign, new accessories, glossy anime details, full body or side profile.
```

### surprised

```text
Use case: ui-mockup
Create ONE surprised expression variant of the attached finished Grok neutral avatar for a desktop chat app.
The input is the identity, style and framing reference. Preserve exactly the long loose warm blonde hair, black square clip with white X on viewer right, matte gray-blue eyes, black jacket with small white X, black high-neck shirt, thick simple dark outlines, large simple chibi face and tiny bust.
Change only the expression to: wide eyes, raised eyebrows, tiny O mouth.
Front-facing centered head-and-shoulders crop, same square canvas and scale, keep entire hair and bust silhouette inside transparent padding. Restraint in pastel cel shading and interior detail; readable at 24-36 pixels.
Eyes have flat single-color matte irises; NO white catchlights, sparkle, shine, gloss, reflective dots or iris gradients.
True transparent RGBA background. No text, slogans, frame, watermark, scenery, extra characters, redesign, new accessories, glossy anime details, full body or side profile.
```

### embarrassed

```text
Use case: ui-mockup
Create ONE embarrassed expression variant of the attached finished Grok neutral avatar for a desktop chat app.
The input is the identity, style and framing reference. Preserve exactly the long loose warm blonde hair, black square clip with white X on viewer right, matte gray-blue eyes, black jacket with small white X, black high-neck shirt, thick simple dark outlines, large simple chibi face and tiny bust.
Change only the expression to: averted gaze, rosy blush, nervous closed smile.
Front-facing centered head-and-shoulders crop, same square canvas and scale, keep entire hair and bust silhouette inside transparent padding. Restraint in pastel cel shading and interior detail; readable at 24-36 pixels.
Eyes have flat single-color matte irises; NO white catchlights, sparkle, shine, gloss, reflective dots or iris gradients.
True transparent RGBA background. No text, slogans, frame, watermark, scenery, extra characters, redesign, new accessories, glossy anime details, full body or side profile.
```

### worried

```text
Use case: ui-mockup
Create ONE worried expression variant of the attached finished Grok neutral avatar for a desktop chat app.
The input is the identity, style and framing reference. Preserve exactly the long loose warm blonde hair, black square clip with white X on viewer right, matte gray-blue eyes, black jacket with small white X, black high-neck shirt, thick simple dark outlines, large simple chibi face and tiny bust.
Change only the expression to: knit brows, uncertain wide eyes, downturned mouth.
Front-facing centered head-and-shoulders crop, same square canvas and scale, keep entire hair and bust silhouette inside transparent padding. Restraint in pastel cel shading and interior detail; readable at 24-36 pixels.
Eyes have flat single-color matte irises; NO white catchlights, sparkle, shine, gloss, reflective dots or iris gradients.
True transparent RGBA background. No text, slogans, frame, watermark, scenery, extra characters, redesign, new accessories, glossy anime details, full body or side profile.
```

### sad

```text
Use case: ui-mockup
Create ONE sad expression variant of the attached finished Grok neutral avatar for a desktop chat app.
The input is the identity, style and framing reference. Preserve exactly the long loose warm blonde hair, black square clip with white X on viewer right, matte gray-blue eyes, black jacket with small white X, black high-neck shirt, thick simple dark outlines, large simple chibi face and tiny bust.
Change only the expression to: drooping eyelids and brows, downturned mouth, gently sad expression.
Front-facing centered head-and-shoulders crop, same square canvas and scale, keep entire hair and bust silhouette inside transparent padding. Restraint in pastel cel shading and interior detail; readable at 24-36 pixels.
Eyes have flat single-color matte irises; NO white catchlights, sparkle, shine, gloss, reflective dots or iris gradients.
True transparent RGBA background. No text, slogans, frame, watermark, scenery, extra characters, redesign, new accessories, glossy anime details, full body or side profile.
```

### angry

```text
Use case: ui-mockup
Create ONE angry expression variant of the attached finished Grok neutral avatar for a desktop chat app.
The input is the identity, style and framing reference. Preserve exactly the long loose warm blonde hair, black square clip with white X on viewer right, matte gray-blue eyes, black jacket with small white X, black high-neck shirt, thick simple dark outlines, large simple chibi face and tiny bust.
Change only the expression to: lowered brows, narrowed eyes, tense frown, no flames or symbols.
Front-facing centered head-and-shoulders crop, same square canvas and scale, keep entire hair and bust silhouette inside transparent padding. Restraint in pastel cel shading and interior detail; readable at 24-36 pixels.
Eyes have flat single-color matte irises; NO white catchlights, sparkle, shine, gloss, reflective dots or iris gradients.
True transparent RGBA background. No text, slogans, frame, watermark, scenery, extra characters, redesign, new accessories, glossy anime details, full body or side profile.
```

### tired

```text
Use case: ui-mockup
Create ONE tired expression variant of the attached finished Grok neutral avatar for a desktop chat app.
The input is the identity, style and framing reference. Preserve exactly the long loose warm blonde hair, black square clip with white X on viewer right, matte gray-blue eyes, black jacket with small white X, black high-neck shirt, thick simple dark outlines, large simple chibi face and tiny bust.
Change only the expression to: half-lidded sleepy eyes, drooping brows, weary mouth, subtle under-eye shading.
Front-facing centered head-and-shoulders crop, same square canvas and scale, keep entire hair and bust silhouette inside transparent padding. Restraint in pastel cel shading and interior detail; readable at 24-36 pixels.
Eyes have flat single-color matte irises; NO white catchlights, sparkle, shine, gloss, reflective dots or iris gradients.
True transparent RGBA background. No text, slogans, frame, watermark, scenery, extra characters, redesign, new accessories, glossy anime details, full body or side profile.
```

### waiting

```text
Use case: ui-mockup
Create ONE waiting expression variant of the attached finished Grok neutral avatar for a desktop chat app.
The input is the identity, style and framing reference. Preserve exactly the long loose warm blonde hair, black square clip with white X on viewer right, matte gray-blue eyes, black jacket with small white X, black high-neck shirt, thick simple dark outlines, large simple chibi face and tiny bust.
Change only the expression to: patient expectant expression, gaze slightly to one side, small hopeful closed mouth.
Front-facing centered head-and-shoulders crop, same square canvas and scale, keep entire hair and bust silhouette inside transparent padding. Restraint in pastel cel shading and interior detail; readable at 24-36 pixels.
Eyes have flat single-color matte irises; NO white catchlights, sparkle, shine, gloss, reflective dots or iris gradients.
True transparent RGBA background. No text, slogans, frame, watermark, scenery, extra characters, redesign, new accessories, glossy anime details, full body or side profile.
```

## Generated sources

Neutral: exec-8e15ea48-a60c-435f-acdf-ab4ccf1855e6.png
- thinking: exec-a64dee49-531f-486d-8a0c-e4d562443c83.png
- speaking: exec-b54de60e-c271-4ddc-8838-1f07fa05fb4c.png
- happy: exec-3b523c4a-0ed3-4da0-8c01-774729ea0266.png
- confident: exec-174cdf69-e09e-4bd5-8bd1-021ef6dfd811.png
- surprised: exec-4b34175a-794d-45e0-b002-9f9b8d8ad110.png
- embarrassed: exec-bdc189c4-ac14-45f0-b223-953313efa491.png
- worried: exec-6b9bf8a2-1934-4cbb-8bd2-b76d2ca71c46.png
- sad: exec-7ce2698a-d008-4bb2-962b-42f65e1b3287.png
- angry: exec-9d7e00e7-81e4-4204-87e5-964f530d61af.png
- tired: exec-e7261ec8-756f-46a7-957d-aab02fd6a94d.png
- waiting: exec-39ae19a2-c0f8-4e36-b7a5-eb01f9512404.png
