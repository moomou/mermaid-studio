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
**Open** to import a `.mmd` file into its own tab, and the close control on each
tab to remove it. Tabs, sources, layout choices, the active tab, and the
light/dark appearance are restored on the next visit.

The toolbar also provides source input, SVG/PNG export, zoom, fit, and a
light/dark toggle. The source dialog allows the same source to be rendered with
original Mermaid, or with only its declared subgraphs rather than inferred
regions. Select a node or arrow to trace its connections; click blank space or
press Escape to clear. Authored safe hyperlinks remain links.

Drag or scroll to pan; Ctrl/Command + scroll zooms. With the canvas focused,
arrow keys pan, `+`/`-` zoom, and `0` fits the whole diagram. All label lines are
shown by default; details are not reduced to smaller, fainter text.

## How the guidance works

The pinned, official Mermaid parser handles syntax and produces an owned graph
snapshot. It is not a regex reimplementation of the grammar.

1. Declared outer subgraphs become indivisible units during region inference.
   Their nested boundaries are retained.
2. Weighted connectivity merges related units. Dotted edges have less influence
   than solid edges. Disconnected components are not merged merely to hit a
   region-count target.
3. An independently rooted subgraph stays separate when outside control links
   only join it downstream of its entry.
4. Each region gets a compact local layout. Cross-region connections are then
   routed around nodes and captions, so return links do not distort the main
   flow. Every visible source edge is an actual drawn connection.

Parallel cross-region routes reserve 14 SVG units of clearance and stay 10 units
away from parallel group borders. Shared destinations get separate arrival
points. Labels avoid other wires and boundary outlines; fractional grid cells
are not treated as adequate spacing.

Region headings come from entry nodes/subgraphs. They are topology-based reading
aids, **not generated architectural meaning or a claim of execution order**.
There are no deployment-specific rules or keyword checks.

ELK.js performs local box placement in a browser worker. A separate orthogonal
router connects the regions. ELK is a replaceable JavaScript library, not an
Eclipse platform dependency.

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

Other diagram types, unsupported modern shapes, image/icon nodes, and animated
edges use native Mermaid rendering, with an explicit explanation. Native
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

## Limits and privacy

There is a 50,000-character source limit, a 500-edge parser limit, and a
200-node/group structured-layout limit. Invalid edits show an error and retain
the previous diagram, with image exports paused until corrected or cancelled.
Queued renders cannot replace a newer edit with stale output.
The separated-route grid is capped at 160,000 points; excessively dense layouts
report an explicit error and can be viewed with the original Mermaid layout.

Successfully rendered tabs and the selected appearance are saved in local
browser storage. No diagram source is uploaded. External assets explicitly
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

| Module | Responsibility |
| --- | --- |
| `src/parser.ts` | Serialized Mermaid parsing, safe source appearance, graph snapshots |
| `src/structure.ts` | Deterministic topology-based regions, preservation of declared boundaries |
| `src/layout.ts` / `src/geometry.ts` | Local layout, natural sizing, shape intersections |
| `src/routing.ts` | Actual cross-region arrows and label placement |
| `src/render.ts` | SVG shapes, source styling, reading guides, tracing |
| `src/main.ts` / `src/viewport.ts` | Minimal viewer and on-demand source dialog |
| `src/export.ts` | Complete SVG and bounded PNG output |

The layout accepts an injected engine and text-measurement function; graph
inference is independent of the viewer UI. Mermaid is MIT-licensed and ELK.js is
EPL-2.0-licensed.
