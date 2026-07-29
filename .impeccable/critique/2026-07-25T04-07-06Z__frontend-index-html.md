---
target: frontend/index.html
total_score: 24
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 3
timestamp: 2026-07-25T04-07-06Z
slug: frontend-index-html
---
Method: dual-agent (A: /root/assessment_a · B: /root/assessment_b)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Operation status, loading, progress, sync badge and toasts exist, but recovery is often transient. |
| 2 | Match System / Real World | 3 | Core Chinese language is natural; `backend/data/books`, `AI 索引`, and `DeepSeek` leak implementation language. |
| 3 | User Control and Freedom | 3 | Back/collapse/close paths exist; undo and post-delete recovery are weak. |
| 4 | Consistency and Standards | 3 | Tokens and components are coherent; several primary actions compete in the same local decision. |
| 5 | Error Prevention | 2 | Book deletion has a modal; note deletion and generation/export flows rely more on after-the-fact messaging. |
| 6 | Recognition Rather Than Recall | 3 | Most controls are labeled; reader search and panel states still require state memory. |
| 7 | Flexibility and Efficiency | 2 | Keyboard accelerators exist but are undiscoverable; bulk/expert paths are limited. |
| 8 | Aesthetic and Minimalist Design | 2 | The palette is quiet, but reader and studio expose too many decisions at once. |
| 9 | Error Recovery | 2 | Toasts are plain-language, but many errors lack contextual next actions. |
| 10 | Help and Documentation | 1 | Microcopy helps, but there is no persistent task help, shortcut hint, or AI capability guidance. |
| **Total** | | **24/40** | **Acceptable** |

## Design Specificity Verdict

**LLM assessment:** Marginalia has a credible authored visual base. The warm paper canvas, ink-green accent, serif headings, small radii, fine borders, and restrained shadows are aligned with `静谧书斋`; this is not a generic blue SaaS shell. The weakness is not the palette. The weakness is orchestration: the reader and creation views still behave like productivity dashboards showing every capability at once. The unique promise, “from reading to thought to reusable output,” is visible but not yet emotionally sequenced.

**Deterministic scan:** `node C:\Users\Family\.codex\skills\impeccable\scripts\detect.mjs --json frontend/index.html` exited `0` with `[]`. No rule names, counts, or file locations were reported.

**Visual overlays:** No reliable user-visible overlay is available. Browser page load succeeded at `http://127.0.0.1:5811/frontend/index.html`, but mutable injection preflight failed because the browser rejected the non-`evaluate` mutation route. Since this Browser surface treats Playwright `evaluate(...)` as read-only for mutation, overlay injection was skipped.

## Overall Impression

The interface now has the right atmosphere: quiet paper, pine ink, and restrained craft. The largest opportunity is to make the workflow as calm as the palette. The current layout gives the owner all tools, all the time; the next version should reveal AI, notes, search, generation, and export at the moment they serve the reading or thinking act.

## What's Working

- The visual system is strongly aligned with the product: `frontend/style.css` defines the intended paper, ink, pine, gold, typography, radii, and shadow vocabulary.
- Status surfaces respect the local/offline workflow: operation status, reader loading, progress, sync badge, retry hooks, and toasts are present.
- The product model is coherent in one file: library, reader, highlights, AI Q&A, creation, draft editing, and Obsidian export are all represented in `frontend/index.html`.

## Priority Issues

**[P1] The reader loses the quiet reading center**

**Why it matters:** The reader shows toolbar actions, search, AI, bookmarks, notes, page controls, progress, and sync at once. That makes the reading surface feel managed rather than contemplative.

**Fix:** Default to a quieter reading mode: visible book/chapter/progress, page controls, and one tools affordance. Move AI/search/bookmark/notes into contextual drawers or a command shelf.

**Suggested command:** `$impeccable distill`

**[P1] Creation exposes the whole pipeline before the first decision**

**Why it matters:** Materials, filters, reflection, prompt fields, two generation buttons, draft list, editor, save, and export all compete before the user knows what the next step is.

**Fix:** Stage the flow as `摘录 → 判断 → 成稿 → 入库`. Keep expert three-pane density on wide screens, but add active-step emphasis and delay future actions until prerequisites are clear.

**Suggested command:** `$impeccable shape`

**[P1] Accessibility semantics lag behind the visual craft**

**Why it matters:** The app looks controlled but low-vision and keyboard/screen-reader users face avoidable barriers: `user-scalable=no`, modal semantics are missing, and button focus treatment is weaker than input focus.

**Fix:** Remove zoom blocking, add dialog roles and labels, trap/restore focus in modals, add global `:focus-visible` states, and audit aria-expanded/selected/live states.

**Suggested command:** `$impeccable audit`

**[P2] Product copy leaks implementation details at high-emotion moments**

**Why it matters:** `backend/data/books`, `DeepSeek`, and `AI 索引` interrupt the private-study tone and make the product feel more like a setup console.

**Fix:** Rewrite main copy around user intent and move local technical instructions into secondary disclosure. Use capability language for the model unless the engine is intentionally part of the brand.

**Suggested command:** `$impeccable clarify`

**[P2] Primary actions compete inside creation**

**Why it matters:** `生成视频号稿` and `生成公众号稿` are both primary; `刷新素材` is also primary in the header. The intended next action is not visually singular.

**Fix:** Use one primary per stage. Make output format a segmented choice or menu, then one `生成草稿` action. Demote refresh unless stale data is the current problem.

**Suggested command:** `$impeccable layout`

## Persona Red Flags

**Alex, power user:** Arrow-key navigation and Ctrl/Cmd+S exist, but shortcuts are invisible. Search appears both as an input and a toggle, slowing expert scanning. Draft generation is split across repeated primary buttons instead of a configurable fast path.

**Jordan, first-timer:** The first import action is clear, but the empty state mentions `backend/data/books`; `AI 索引` and `DeepSeek` assume technical context. The creation screen has no clear “start here” signal.

**Sam, accessibility-dependent user:** Browser zoom is disabled; modals lack explicit dialog semantics; button focus styling is not as strong as input focus; highlight color controls need robust state announcement if color selection persists.

**Owner-reader turning notes into publishable thinking:** The product moves from contemplative reading to content production too abruptly. The peak moment, saving an insight, is visually treated as just another save/delete row.

## Minor Observations

- `theme-color` is close to, but not the same as, the documented pine green.
- The reader content host shadow is stronger than most paper surfaces; it works now, but should not become more floating.
- Several `white-space: nowrap` rules keep controls tidy but should be guarded on Chinese mobile layouts.
- The selection toolbar is one of the strongest objects: contextual, compact, product-specific, and appropriately restrained.

## Questions to Consider

- What if “阅读” mode refused to show AI/search/notes until the reader expresses intent?
- What if creation had a visible ritual, `摘录 → 判断 → 成稿 → 入库`, instead of three simultaneous panes?
- Is `DeepSeek` part of the product promise, or just the current engine?
- What is the one moment Marginalia should make feel precious: importing a book, making a highlight, writing a reflection, generating a draft, or exporting to Obsidian?
