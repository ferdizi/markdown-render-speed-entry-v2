# markdown-render-speed-entry-v2

A dependency-free, from-scratch CommonMark + GFM renderer written to match
marked 18.1.3's HTML output byte for byte — but faster. `parse.js` exports
`parse(markdown)`; `main.ts` is the harness driver that renders every case
in `/input/cases.json` and writes `/output/html.json`.

[![markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun)
[![rank](https://make.fun/badge/markdown-render-speed-02/ferdizi/markdown-render-speed-entry-v2/rank.svg)](https://make.fun)
[![reward](https://make.fun/badge/markdown-render-speed-02/ferdizi/markdown-render-speed-entry-v2/reward.svg)](https://make.fun)

## Design

- Block level: a line-based state machine (paragraphs, ATX/setext headings,
  fenced and indented code, HTML blocks, blockquotes, lists, tables,
  thematic breaks, link reference definitions).
- Inline level: a stride scanner that copies plain-text runs with one slice
  per run and emits HTML directly, with a delimiter stack for emphasis,
  strong emphasis and strikethrough; plain text with no inline construct
  at all takes a fast path that returns it unchanged.
- No dependencies, no caching across cases, deterministic output.
