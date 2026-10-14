# Gemini character art

이 문서는 AI ChatterBox에 추가한 Gemini 12종 표정 자산의 생성 기록과 검증 결과를 보관한다.

## 기준과 사용자 확인

- 원본/참고 URL: https://dccon.dcinside.com/hot/1/title/%EC%A0%9C%EB%AF%B8%EB%82%98%EC%9D%B4#174093
- 사용자가 확인한 기준: `neutral.png`는 위 원본을 기준으로 확인한 AI 제미나이 디시콘 캐릭터이며, 이번 표정 생성의 유일한 기준 이미지다.
- 기준 파일: `src/renderer/public/characters/gemini/neutral.png`
- 기본 얼굴을 먼저 생성하고 나머지 표정의 기준으로 유지했다.
- 사용자 첨부 참고 이미지는 `docs/character-references/gemini-user-reference.png`에 보관했다.
- 다운로드한 원본 참고 이미지는 `docs/character-references/gemini-source.png`에 보관했다.
- 보존할 identity: 금발 양갈래, 분홍-자주색 머리끝, 청록 리본, 파란 무광 눈, 파랑·노랑 별 머리핀, 흰 셔츠, 남색 조끼.
- 공통 화풍: 같은 굵은 어두운 외곽선, 큰 단순 치비 얼굴, 절제한 파스텔 셀 셰이딩, 최소한의 내부 디테일, 정면 헤드 앤 숄더, 24~36px에서도 읽히는 형태.
- 눈 규칙: 홍채는 파란색 단색 무광 채움만 사용하며 흰 반사광, 광택, 반짝임, 반사점, 홍채 그라데이션을 넣지 않는다.

## 생성 방법

- 도구: built-in `image_gen.imagegen`
- 호출 수: root가 `neutral`을 같은 built-in 도구로 1회 생성했고, 나머지 11개 표정은 표정당 1회 생성했다. 총 12회다.
- `transparent_background: true`
- 표정 변형 11회의 `referenced_image_paths`: `C:\Apps\AI_ChatterBox\src\renderer\public\characters\gemini\neutral.png`
- 생성 원본은 도구 출력 경로에서 프로젝트 경로로 복사했다.
- Python으로 이미지를 수정하거나 재인코딩하지 않았다.

### Neutral base

`neutral.png`는 사용자 확인 기준과 기존 마스터 화풍 이미지를 참조해 같은 도구로 생성했다.

- Project output: `src/renderer/public/characters/gemini/neutral.png`
- Reference images (순서대로): `docs/character-references/gemini-source.png`, `src/renderer/public/characters/orch/neutral.png`
- Generated source: `C:\Users\damki\.codex\generated_images\01a1336d-1d77-78c2-8456-fbce98edb48c\exec-98453165-d5bc-43c2-a57e-dc7d53dd4a43.png`

```text
Use case: style-transfer
Asset type: transparent chibi face and bust icon for a desktop chat UI, readable at 24-36 px.
Primary request: Draw the Gemini meme character from image 1 as a neutral icon matching the simple chibi drawing style of image 2.
Input images: Image 1 is Gemini's identity reference, preserve golden blonde twin ponytails with pink-to-magenta tips, teal bows, blue eyes, star-shaped hair clips, white blouse, teal ribbon and dark navy vest. Image 2 is ONLY the app's master style and framing reference, do not copy its hair/clothes/eye color.
Subject: one centered front-facing head-and-shoulders Gemini chibi portrait, neutral calm mouth, relaxed slightly half-lidded eyes.
Style: match image 2's thick simple dark outline, very large simple face, minimal pastel cel shading and few interior details.
Composition: square canvas, centered bust, same scale and transparent padding as image 2. Hair and bows fully inside frame.
Eyes: flat single-color muted blue irises with NO white catchlights, NO sparkle, NO gloss, NO reflective dots, NO gradients, matching image 2's matte eyes.
Backdrop: genuinely transparent alpha, no background, no white rectangle, no checkerboard.
Constraints: no text, caption, speech bubble, button, props, frame, watermark, extra character, full body, realistic or detailed glossy anime rendering. Preserve Gemini identity while matching the existing master icon style.
```

### 공통 프롬프트

아래 프롬프트에서 `{expression}`과 `{expression detail}`만 표의 값으로 치환해 각 표정에 정확히 한 번씩 사용했다.

```text
Use case: ui-mockup
Asset type: transparent chibi character face/bust icon for a desktop chat UI
Primary request: Create the {expression} expression variant from the attached finished neutral character base. Preserve identity and the same simplified master chibi style while changing only the expression: {expression detail}.
Input images: Image 1 is the finished neutral identity and style reference for Gemini; preserve the blonde twin-tails with pink-to-magenta tips, teal ribbons, matte blue eyes, blue-and-yellow star hairpin, white shirt, and navy vest.
Scene/backdrop: genuinely transparent alpha background, no environment.
Subject: one centered front-facing head-and-shoulders chibi portrait.
Style/medium: same thick simple dark outline, large simple chibi face, restrained pastel cel shading, minimal interior detail, matching the attached neutral.
Composition/framing: match the neutral square canvas, centered bust, same scale and transparent padding.
Lighting/mood: soft even light without eye reflections.
Color palette: match the neutral base.
Constraints: keep hair, eyes, hair accessory, clothing, crop, outline weight, and transparent alpha. Irises must be matte flat single-color blue fills; absolutely no white catchlights, sparkle, gloss, shine, reflective dots, or iris gradients. Show {expression} only via {expression detail}; no background, text, frame, watermark, or extra characters; readable at 24-36 px.
Avoid: thin detailed anime linework, glossy/sparkling eyes, redesign, changed accessories/clothes, full body, side profile, realism, scenery, symbols, borders, opaque background.
```

## 표정 프롬프트와 출력 매핑

| Expression | Exact expression detail | Project output | Generated source |
| --- | --- | --- | --- |
| thinking | one eyebrow raised, eyes upward, thoughtful mouth, minimal hand near chin | `src/renderer/public/characters/gemini/thinking.png` | `C:\Users\damki\.codex\generated_images\01a13832-72a3-7343-9eac-0ba09e039ca6\exec-c6215834-5953-4a3a-9391-fa8cdff8d85c.png` |
| speaking | small open talking mouth, one hand near the chest, no speech bubble or text | `src/renderer/public/characters/gemini/speaking.png` | `C:\Users\damki\.codex\generated_images\01a13832-72a3-7343-9eac-0ba09e039ca6\exec-d9159da6-9970-429b-8244-b93f28085f7a.png` |
| happy | cheerful open smile, lifted cheeks, soft rosy blush, simple happy eyelids or matte irises only | `src/renderer/public/characters/gemini/happy.png` | `C:\Users\damki\.codex\generated_images\01a13832-72a3-7343-9eac-0ba09e039ca6\exec-0c6cc491-e050-4ea3-9f34-354cc73f4ef9.png` |
| confident | steady eyes, slightly lifted chin, raised brow, knowing smile | `src/renderer/public/characters/gemini/confident.png` | `C:\Users\damki\.codex\generated_images\01a13832-72a3-7343-9eac-0ba09e039ca6\exec-dc61204c-660b-4b74-9567-ca2e7343566c.png` |
| surprised | wide matte eyes, raised eyebrows, tiny O mouth | `src/renderer/public/characters/gemini/surprised.png` | `C:\Users\damki\.codex\generated_images\01a13832-72a3-7343-9eac-0ba09e039ca6\exec-f72ebafa-e7f8-41cb-975e-320e6b43c527.png` |
| embarrassed | averted gaze, rosy blush, nervous closed smile | `src/renderer/public/characters/gemini/embarrassed.png` | `C:\Users\damki\.codex\generated_images\01a13832-72a3-7343-9eac-0ba09e039ca6\exec-853af0d7-c4a5-4683-b29d-04ef223c58bf.png` |
| worried | knit brows, uncertain wide eyes, downturned mouth | `src/renderer/public/characters/gemini/worried.png` | `C:\Users\damki\.codex\generated_images\01a13832-72a3-7343-9eac-0ba09e039ca6\exec-1d11361d-2155-4d56-bc05-d13ac2ffbc8c.png` |
| sad | drooping eyelids and brows, downturned mouth, gentle tearful sadness | `src/renderer/public/characters/gemini/sad.png` | `C:\Users\damki\.codex\generated_images\01a13832-72a3-7343-9eac-0ba09e039ca6\exec-ee54ce95-5689-4f6d-a7ea-e16f81be26fa.png` |
| angry | lowered brows, narrowed eyes, tense frown, no flames or symbols | `src/renderer/public/characters/gemini/angry.png` | `C:\Users\damki\.codex\generated_images\01a13832-72a3-7343-9eac-0ba09e039ca6\exec-11895aff-8afb-4ea4-bb6f-c17416528ad7.png` |
| tired | half-lidded sleepy eyes, drooping brows, weary mouth, subtle under-eye shading | `src/renderer/public/characters/gemini/tired.png` | `C:\Users\damki\.codex\generated_images\01a13832-72a3-7343-9eac-0ba09e039ca6\exec-85e85651-95dd-4f0e-8145-0f002426b759.png` |
| waiting | patient expectant expression, gaze slightly to one side, small hopeful closed mouth, calm waiting mood | `src/renderer/public/characters/gemini/waiting.png` | `C:\Users\damki\.codex\generated_images\01a13832-72a3-7343-9eac-0ba09e039ca6\exec-7bd8796d-5c72-4492-8e1c-44044320272d.png` |

> Note: the embarrassed generated source path is `exec-853af0d7-c4a5-4683-b29d-04ef223c58bf.png`; the mapping above preserves the exact source emitted by the tool.

## Validation

Read-only Pillow validation after copying:

- 12 expected files present; 0 missing (root-generated `neutral` plus 11 expression variants).
- Every file is PNG, `RGBA`, `1254 x 1254`.
- Every file has alpha extrema `(0, 255)`.
- Each generated image was visually inspected for the shared identity, transparent background, thick outline, expression, and matte blue irises.
- `neutral.png` remains `RGBA`, `1254 x 1254`, alpha extrema `(0, 255)`, and was not overwritten.
