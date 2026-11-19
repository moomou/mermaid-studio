# Mermaid Studio

A browser-based graph viewer using standard Mermaid syntax. The goal is **guidance for
reading the diagram, not a redesigned application around it**.

**Live app:** https://paul.mou.dev/mermaid-studio/

The whole graph stays visible: no dashboard, overview cards, collapsed steps,
or numbered-reference lookups. Natural node sizes, consistent text, source
colors, light reading-region headings, and quieter secondary connections keep
the presentation close to a conventional diagram.

## Run

Use Node.js 22.18 or newer:

```sh
git clone https://github.com/moomou/mermaid-studio.git
cd mermaid-studio
npm ci
npm run dev
```

Open **http://127.0.0.1:4381**. This project has its own package scripts, separate
from the monorepo root. There is no backend, account, AI service, Java runtime,
or Eclipse IDE requirement.

The tab strip keeps multiple diagrams open locally. Use **+** for a new diagram,
**Open** to import a `.mmd`, `.mermaid`, or Markdown (`.md`, `.markdown`, `.mdown`)
file, and the close control on each tab to remove it. Every fenced `mermaid`
block in a Markdown document opens in its own tab, in document order; the first
is selected. Prose and other code blocks are ignored. Backtick and tilde fences,
including fences in lists and blockquotes, are supported. All blocks are checked
before any tabs are added, so a bad block cannot cause a partial import.
Tabs, sources, layout choices, the active tab, and the
light/dark appearance are restored on the next visit.

The toolbar also provides source input, SVG/PNG export, zoom, fit, and a
light/dark toggle. **Source accepts pasted Markdown directly:** paste a whole
document containing fenced `mermaid` blocks and click **Render** or press
Ctrl/Command + Enter. The first diagram replaces the current tab; additional
diagrams open in new tabs. Prose and fences are removed from each diagram's
editable source. If any block is invalid, the previous diagram and tabs remain
intact. Standalone Mermaid syntax continues to work unchanged.

The source dialog allows the same source to be rendered with
original Mermaid, or with only its declared subgraphs rather than inferred
regions. Select a node or arrow to trace its connections; click blank space or
press Escape to clear. Authored safe hyperlinks remain links.

Drag or scroll to pan; Ctrl/Command + scroll zooms. With the canvas focused,
arrow keys pan, `+`/`-` zoom, and `0` fits the whole diagram. All label lines are
shown by default; details are not reduced to smaller, fainter text.

## How the guidance works

The pinned, official Mermaid parser handles syntax and produces an owned graph
snapshot. It is not a regex reimplementation of the grammar.

1. A compact, connected layout is compared with a reading-region layout. Canvas
   proportions, overall extent, wire length, and curvature guide the choice. Extra
   regions must provide a substantial improvement, rather than splitting a
   simple branch or hub merely to reach a region-count target.
2. Declared outer subgraphs become indivisible units during region inference.
   Their nested boundaries are retained.
3. Weighted connectivity merges related units. Dotted edges have less influence
   than solid edges. Disconnected components are not merged merely to hit a
   region-count target.
4. An independently rooted subgraph stays separate when outside control links
   only join it downstream of its entry.
5. Each region is completed before composition: its nodes, internal curves,
   feedback lanes, captions, and labels all contribute to its bounds. Bridges
   then connect the finished regions through their gutters. Every visible
   source edge remains an individually drawn and traceable connection.

Simple charts have no invented headings, numbering, or placeholder diagram
title. Nodes use the same 16-pixel text size as standard Mermaid, with smaller
natural boxes and shape-aware label wrapping. An acyclic backbone determines
placement, with balanced forks and joins. Dotted connections still constrain
placement unless they close a cycle; feedback and self-loops get their own
routes rather than displacing the forward spine.

Visible wires are tangent-continuous cubic curves, not rounded right-angle
traces. Routing penalizes integrated curvature, so a tiny hook costs more than a
deliberate broad turn. Decisions depart toward their targets; headings move
away from entry axes instead of making the spine detour around text.

Compatible fans may share stems, while distinct relation styles and opposing
returns retain separate ports. Layout-only spacers reserve real curve and label
corridors without adding visible nodes. Labels are placed on their actual
connections and avoid other wires, nodes, and unrelated boundaries.

Region headings come from entry nodes/subgraphs. They are topology-based reading
aids, **not generated architectural meaning or a claim of execution order**.
There are no deployment-specific rules or keyword checks.

ELK.js performs local box placement in a browser worker. The flow router owns
semantic ports, smooth connections, shared stems, and return lanes. A bounded
orthogonal router supplies optional obstacle guides; its grid is not the visible
wire style. ELK is a replaceable JavaScript library, not an Eclipse platform
dependency.

## Appearance and syntax

The structured renderer supports flowcharts: all four directions, classic
shapes, common modern shape aliases, nested subgraphs, subgraph endpoints,
chained/parallel edges, cycles, self-loops, and normal, dotted, thick, invisible,
bidirectional, arrow, circle, and cross edge markers.

Static fills, strokes, text colors, stroke widths, and dash patterns are taken
from `classDef`, `class`, `style`, and `linkStyle`. The standard frontmatter
`config.themeVariables.background` controls the canvas color. Inferred regions
do not add large filled panels or override node colors. Typography and routing
are renderer-owned, rather than a pixel-identical implementation of Mermaid CSS.
Stroke widths are capped at 12 pixels.

HTML/Markdown labels become safe plain SVG text, with line breaks and entities
preserved. Absolute HTTP(S) and mailto links are supported; JavaScript callbacks
and relative links are disabled. Invisible edges constrain local layout but do
not invent visible connections or determine region membership.

Other diagram types, unsupported modern shapes, image/icon nodes, animated
edges, and layouts that cannot safely place every connection use native
Mermaid rendering, with an explicit explanation. Native
diagrams support SVG export; PNG export is for the structured view.

## Reference and comparison

The included KidsMealToys example is a **transcription of a supplied PNG**. Its
original Mermaid source was not provided. The sample retains the pictured
24 nodes, 26 connections, and five declared boundaries, with an approximate
classic palette. It is not a recovery of the image's original layout/source.

Use the same source in both layout modes for a renderer comparison. Do not
confuse the sample's native Mermaid layout with the uploaded reference image.
The original image remains the visual reference; geometry checks alone do not
prove an aesthetic or comprehension improvement.

The sample is in `src/examples.ts`; use **Source > Save .mmd** for the exact
source currently being rendered.

The repeatable comparison corpus contains 40 cases: all four flow directions,
simple branches, cycles, self-loops, parallel edges, disconnected components,
hubs, dense layers, nested groups, group endpoints, long labels, Chinese labels,
styles, and nine native-rendering cases. Run the dev server and open
`http://127.0.0.1:4381/tests/visual.html` for side-by-side standard Mermaid and
Studio rendering from identical source. The gallery deliberately uses equal
panel sizes; fitted node-label size is supporting evidence, not an aesthetic
score or a claim that every possible diagram is better.

With `agent-browser` installed, capture all comparisons and check actual uploads,
exports, fallback, persistence, and mobile behavior:

```sh
node --experimental-strip-types tests/compare-rendering.mjs http://127.0.0.1:4381 /tmp/mermaid-comparisons
node --experimental-strip-types tests/check-paste.mjs http://127.0.0.1:4381 /tmp/mermaid-paste-check
node tests/check-ui.mjs http://127.0.0.1:4381 /tmp/mermaid-ui-check
```

These commands run sequentially in isolated browser sessions and close them on
completion, including failures.

## Limits and privacy

There is a 50,000-character source limit, a 500-edge parser limit, and a
200-node/group structured-layout limit. Opened files and pasted Markdown are
limited to 200 KB and 50 Mermaid blocks per Markdown document. Invalid edits
show an error and retain the previous diagram, with image exports paused until
corrected or cancelled.
Queued renders cannot replace a newer edit with stale output.
The optional obstacle-guide grid is capped at 160,000 points. If a safe structured
drawing cannot be produced, the app falls back to original Mermaid with an
explanation.

Only one structured layout is cached, and closing its tab releases that cache.
Unchanged renders reuse the parsed graph without rewriting browser storage.
Native-only sessions do not start an ELK worker. Routing reuses grid-search
scratch buffers across connections within the grid limit.

Imported tabs, successfully rendered edits, and the selected appearance are saved
in local browser storage. No diagram source is uploaded. External assets explicitly
referenced by a native Mermaid diagram may still be requested by Mermaid.

Exports contain the complete diagram, not the current pan/zoom crop or selection
dimming. Structured SVGs are self-contained and do not use `foreignObject`.
PNG output is bounded to 16 megapixels and 8,192 pixels per side.

## Development

```sh
npm test
npm run build
npm run preview
```

`docs/` is the production site and supports hosting under a subdirectory. Tests use
Node's built-in runner; browser work uses `agent-browser`.

GitHub Pages serves `docs/` from `main`. The CI workflow rebuilds the site and
fails if the committed production output is stale.

The footer shows the deployed build's date version in UTC. `npm run build`
generates `docs/version.json` and embeds its timestamp into the app. The date
updates when source, public assets, dependencies, or build configuration change;
identical rebuilds reuse the stamp so CI stays reproducible. Commit the version
metadata together with the generated `docs/` assets. Local development is
labelled **Development build**, rather than displaying a deployment date.

| Module | Responsibility |
| --- | --- |
| `src/parser.ts` | Serialized Mermaid parsing, safe source appearance, graph snapshots |
| `src/import.ts` | Markdown fence extraction without rendering document HTML |
| `src/structure.ts` | Deterministic topology-based regions, preservation of declared boundaries |
| `src/layout.ts` / `src/geometry.ts` | Local layout, natural sizing, shape intersections |
| `src/curves.ts` | Cubic geometry, curvature cost, curve bounds, and collision checks |
| `src/flow-routing.ts` | Semantic ports, curve and label placement, shared stems, return lanes |
| `src/routing.ts` | Bounded optional orthogonal obstacle guides |
| `src/render.ts` | SVG shapes, source styling, reading guides, tracing |
| `src/main.ts` / `src/viewport.ts` | Minimal viewer and on-demand source dialog |
| `src/export.ts` | Complete SVG and bounded PNG output |

The layout accepts an injected engine and text-measurement function; graph
inference is independent of the viewer UI. Mermaid and Marked are MIT-licensed;
ELK.js is EPL-2.0-licensed.
