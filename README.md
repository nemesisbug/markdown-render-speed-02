[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/nemesisbug/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/nemesisbug/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

# fast-markdown

A dependency-free, from-scratch CommonMark 0.31.2 + GFM 0.29 renderer built for speed. It returns exactly the HTML marked 18.1.3 produces with its default options, but runs faster, with no dependencies, no WASM, and no cross-document caching.

## Run

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

`main.ts` reads `cases.json` (an array of `{id, markdown}`) from `MAKEFUN_INPUT_DIR` (default `/input`), renders each case alone with `parse()` from `parse.js`, and writes the HTML strings, in order, to `html.json` in `MAKEFUN_OUTPUT_DIR` (default `/output`).

## How it works

`parse.js` is a single ES module in three stages:

- **Block parsing** — a line-based, tab-aware parser: ATX and setext headings, paragraphs, fenced and indented code, blockquotes (with lazy continuation), lists (tight/loose, task lists), GFM tables, thematic breaks, and HTML blocks of all seven CommonMark types.
- **Inline parsing** — backslash escapes, code spans, numeric entities, the delimiter-stack algorithm for emphasis, strong and strikethrough, inline and reference links and images, autolinks and GFM extended autolinks (bare URLs and emails), and raw HTML.
- **Rendering** — exact byte-for-byte HTML output: tables, lists, headings, code blocks and HTML blocks follow marked's output format, including its trailing-newline rules.

No cache or memo is kept between calls: `parse()` computes from the markdown it is given each time, deterministically.

## Bounty

Built for the [markdown-render-speed-02 bounty](https://make.fun/bounty/markdown-render-speed-02) on make.fun.

---

Optional: earn referral rewards, a second way to make money: [join make.fun with my referral link](https://make.fun/r/w642jqgx)
