
// fast-markdown: a dependency-free CommonMark + GFM parser.
// Produces exactly the HTML marked 18.1.3 produces (gfm, breaks off).

// Character helpers.
function isSpaceCh(ch) {
  return (
    ch === ' ' ||
    ch === '\t' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === '\v' ||
    ch === '\f'
  );
}
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCh(ch) {
  return ch.length === 1 && PUNCT_RE.test(ch);
}
// ASCII punctuation only (backslash escapes use this, not Unicode punct).
function isAsciiPunctCh(ch) {
  return (
    ch.length === 1 &&
    '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.indexOf(ch) >= 0
  );
}
function isWordCh(ch) {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '_'
  );
}
function isHexCh(ch) {
  return (
    (ch >= '0' && ch <= '9') ||
    (ch >= 'a' && ch <= 'f') ||
    (ch >= 'A' && ch <= 'F')
  );
}
function isDigitCh(ch) {
  return ch >= '0' && ch <= '9';
}

// Escape text with the "no-encode" rule: &, <, >, ", ' are escaped, except
// an & that starts an entity-shaped sequence (&name; &#123; &#xAB;) is
// left alone.
function escNoEncode(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '&') {
      let j = i + 1;
      let entity = false;
      if (j < n && s[j] === '#') {
        j++;
        if (j < n && (s[j] === 'x' || s[j] === 'X')) {
          j++;
          let digits = 0;
          while (j < n && isHexCh(s[j]) && digits < 6) {
            j++;
            digits++;
          }
          if (digits >= 1 && j < n && s[j] === ';') entity = true;
        } else {
          let digits = 0;
          while (j < n && isDigitCh(s[j]) && digits < 7) {
            j++;
            digits++;
          }
          if (digits >= 1 && j < n && s[j] === ';') entity = true;
        }
        if (entity) {
          out += s.slice(i, j + 1);
          i = j + 1;
          continue;
        }
      } else {
        let j2 = i + 1;
        while (j2 < n && isWordCh(s[j2])) j2++;
        if (j2 > i + 1 && j2 < n && s[j2] === ';') {
          out += s.slice(i, j2 + 1);
          i = j2 + 1;
          continue;
        }
      }
      out += '&amp;';
      i++;
    } else if (ch === '<') {
      out += '&lt;';
      i++;
    } else if (ch === '>') {
      out += '&gt;';
      i++;
    } else if (ch === '"') {
      out += '&quot;';
      i++;
    } else if (ch === "'") {
      out += '&#39;';
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// Escape every escapable character (used for code and decoded entities).
function escPlain(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else out += ch;
  }
  return out;
}

function escDecodedChar(ch) {
  return escPlain(ch);
}

// Decode a numeric entity at `i` (s[i] === '&', s[i+1] === '#').
// Returns { ch, end } or null. 0, surrogates and > 0x10FFFF become U+FFFD.
function decodeNumericEntity(s, i) {
  const n = s.length;
  let j = i + 2;
  let code = 0;
  if (j < n && (s[j] === 'x' || s[j] === 'X')) {
    j++;
    let digits = 0;
    code = 0;
    while (j < n && isHexCh(s[j]) && digits < 6) {
      code = code * 16 + parseInt(s[j], 16);
      j++;
      digits++;
    }
    if (digits < 1 || j >= n || s[j] !== ';') return null;
    j++;
  } else {
    let digits = 0;
    code = 0;
    while (j < n && isDigitCh(s[j]) && digits < 7) {
      code = code * 10 + (s[j].charCodeAt(0) - 48);
      j++;
      digits++;
    }
    if (digits < 1 || j >= n || s[j] !== ';') return null;
    j++;
  }
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    code = 0xfffd;
  }
  return { ch: String.fromCodePoint(code), end: j };
}

// Encode a link destination the way marked does: like encodeURI, but a
// `%` is never encoded (so `foo%20bar`, `foo%2Gbar` and `foo%bar` all keep
// their `%`), then the no-encode attribute escape.
function encodeHref(dest) {
  const parts = dest.split('%');
  let encoded = '';
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) encoded += '%';
    try {
      encoded += encodeURI(parts[i]);
    } catch (e) {
      encoded += parts[i];
    }
  }
  return escNoEncode(encoded);
}

// ---------------------------------------------------------------------------
// Block parsing. Line-based, tab-aware: the cursor tracks a visual column so
// a tab that straddles an indent boundary is partly consumed (the remainder
// becomes spaces at the start of the line's content).
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// Cursor over one source line.
function curSave(c) {
  return [c.i, c.col, c.partial];
}
function curRestore(c, sv) {
  c.i = sv[0];
  c.col = sv[1];
  c.partial = sv[2];
}
function curPeek(c) {
  if (c.partial > 0) return ' ';
  return c.i < c.s.length ? c.s[c.i] : '';
}
function curAdvance(c, n) {
  const s = c.s;
  const len = s.length;
  while (n > 0) {
    if (c.i >= len) {
      c.col += n;
      n = 0;
      break;
    }
    if (c.partial > 0) {
      if (c.partial > n) {
        c.partial -= n;
        c.col += n;
        n = 0;
      } else {
        n -= c.partial;
        c.col += c.partial;
        c.i++;
        c.partial = 0;
      }
    } else if (s[c.i] === '\t') {
      const w = 4 - (c.col % 4);
      if (w > n) {
        c.partial = w - n;
        c.col += n;
        n = 0;
      } else {
        c.i++;
        c.col += w;
        n -= w;
      }
    } else {
      c.i++;
      c.col++;
      n--;
    }
  }
}
// Columns of leading whitespace from the cursor, capped at `cap` (returns
// `cap` when the indent is at least `cap`).
function curMeasureIndent(c, cap) {
  let i = c.i;
  let col = c.col;
  let partial = c.partial;
  let cols = 0;
  const s = c.s;
  const len = s.length;
  while (cols < cap) {
    if (i >= len) break;
    const ch = s[i];
    if (ch === ' ') {
      i++;
      col++;
      cols++;
    } else if (ch === '\t') {
      const w = partial > 0 ? partial : 4 - (col % 4);
      if (cols + w > cap) return cap;
      cols += w;
      col += w;
      i++;
      partial = 0;
    } else break;
  }
  return cols;
}
function curRest(c) {
  if (c.partial > 0) return ' '.repeat(c.partial) + c.s.slice(c.i + 1);
  return c.s.slice(c.i);
}
function curBlank(c) {
  const s = c.s;
  for (let i = c.partial > 0 ? c.i + 1 : c.i; i < s.length; i++) {
    const ch = s[i];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

function blockParse(src) {
  const srcEndsNL = src.endsWith('\n');
  const rawLines = src.split('\n');
  if (srcEndsNL) rawLines.pop();
  const doc = { t: 'doc', children: [] };
  const refs = new Map();
  let tip = doc;
  let blankPending = false;

  function lastOpenChild(container) {
    const ch = container.children;
    if (ch.length === 0) return null;
    const last = ch[ch.length - 1];
    return last.open ? last : null;
  }

  function addChild(parent, node) {
    node.parent = parent;
    node.open = true;
    if (node.children === undefined) node.children = [];
    if (blankPending) {
      node.startsAfterBlank = true;
      blankPending = false;
    }
    parent.children.push(node);
    return node;
  }

  function removeBlock(node) {
    const ch = node.parent.children;
    const idx = ch.indexOf(node);
    if (idx >= 0) ch.splice(idx, 1);
  }

  // Finalize a block that is being closed.
  function finalize(block) {
    block.open = false;
    if (block.t === 'html') {
      // A trailing newline is kept only when the block's last line is the
      // last line of the source.
      block.endsAtEOF = block.lastLineIdx === lastLineIdx;
    }
    if (block.t === 'paragraph') {
      let text = block.lines.join('\n');
      text = stripLinkRefDefs(text, refs);
      if (text === '') {
        removeBlock(block);
        return;
      }
      const lines = text.split('\n');
      const ti = findTableStart(lines);
      if (ti >= 0) {
        const table = makeTable(lines.slice(ti));
        const parent = block.parent;
        const idx = parent.children.indexOf(block);
        if (ti === 0) {
          parent.children.splice(idx, 1, table);
          table.parent = parent;
          table.open = false;
        } else {
          block.lines = lines.slice(0, ti);
          block.text = lines.slice(0, ti).join('\n');
          table.parent = parent;
          table.open = false;
          parent.children.splice(idx + 1, 0, table);
        }
        return;
      }
      block.text = text;
      block.lines = lines;
    } else if (block.t === 'code' && !block.fenced) {
      while (
        block.lines.length > 0 &&
        block.lines[block.lines.length - 1] === ''
      ) {
        block.lines.pop();
      }
    } else if (block.t === 'code' && block.fenced) {
      // A fenced code block loses exactly one trailing blank line.
      if (
        block.lines.length > 0 &&
        block.lines[block.lines.length - 1] === ''
      ) {
        block.lines.pop();
      }
    } else if (block.t === 'list') {
      let tight = true;
      const items = block.children;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.sawBlank && i < items.length - 1) tight = false;
        // An item after the first that starts after a blank line is
        // separated from the previous item by that blank line.
        if (i > 0 && item.startsAfterBlank) tight = false;
        const kids = item.children;
        for (let k = 1; k < kids.length; k++) {
          if (kids[k].startsAfterBlank) tight = false;
        }
      }
      block.tight = tight;
    }
  }

  function closeTo(container) {
    while (tip !== container) {
      const b = tip;
      tip = tip.parent;
      finalize(b);
    }
  }

  // --- new-block start checks (cursor is positioned after container marks)
  function matchAtx(cur) {
    const save = curSave(cur);
    const ind = curMeasureIndent(cur, 4);
    if (ind >= 4) {
      curRestore(cur, save);
      return 0;
    }
    curAdvance(cur, ind);
    let n = 0;
    while (curPeek(cur) === '#') {
      curAdvance(cur, 1);
      n++;
    }
    if (n === 0 || n > 6) {
      curRestore(cur, save);
      return 0;
    }
    const after = curPeek(cur);
    if (after !== '' && after !== ' ' && after !== '\t') {
      curRestore(cur, save);
      return 0;
    }
    return n;
  }

  function atxContent(cur) {
    // cur is just past the #'s; take the rest, strip a closing sequence
    // of #'s (preceded by a space) first, then the surrounding spaces.
    let s = curRest(cur);
    s = s.replace(/[ \t]+$/, '');
    s = s.replace(/[ \t]+#+$/, '');
    s = s.replace(/^[ \t]+/, '');
    s = s.replace(/[ \t]+$/, '');
    return s;
  }

  function matchFence(cur) {
    const save = curSave(cur);
    const ind = curMeasureIndent(cur, 4);
    if (ind >= 4) {
      curRestore(cur, save);
      return null;
    }
    curAdvance(cur, ind);
    const ch = curPeek(cur);
    if (ch !== '`' && ch !== '~') {
      curRestore(cur, save);
      return null;
    }
    let n = 0;
    while (curPeek(cur) === ch) {
      curAdvance(cur, 1);
      n++;
    }
    if (n < 3) {
      curRestore(cur, save);
      return null;
    }
    let info = curRest(cur);
    if (ch === '`' && info.indexOf('`') >= 0) {
      curRestore(cur, save);
      return null;
    }
    info = info.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    return { ch, len: n, info, indent: ind };
  }

  function matchThematicBreak(cur) {
    const save = curSave(cur);
    const ind = curMeasureIndent(cur, 4);
    if (ind >= 4) {
      curRestore(cur, save);
      return false;
    }
    curAdvance(cur, ind);
    const ch = curPeek(cur);
    if (ch !== '-' && ch !== '_' && ch !== '*') {
      curRestore(cur, save);
      return false;
    }
    let n = 0;
    while (true) {
      const c = curPeek(cur);
      if (c === ch) {
        n++;
        curAdvance(cur, 1);
      } else if (c === ' ' || c === '\t') {
        curAdvance(cur, 1);
      } else break;
    }
    if (n < 3 || !curBlank(cur)) {
      curRestore(cur, save);
      return false;
    }
    return true;
  }

  function matchSetext(cur) {
    const save = curSave(cur);
    const ind = curMeasureIndent(cur, 4);
    if (ind >= 4) {
      curRestore(cur, save);
      return 0;
    }
    curAdvance(cur, ind);
    const ch = curPeek(cur);
    if (ch !== '=' && ch !== '-') {
      curRestore(cur, save);
      return 0;
    }
    while (curPeek(cur) === ch) curAdvance(cur, 1);
    if (!curBlank(cur)) {
      curRestore(cur, save);
      return 0;
    }
    return ch === '=' ? 1 : 2;
  }

  // Returns {indent, markerLen, ordered, start, delim} or null.
  // `indent` is the columns of whitespace before the marker.
  function matchListMarker(cur) {
    const save = curSave(cur);
    const ind = curMeasureIndent(cur, 4);
    if (ind >= 4) {
      curRestore(cur, save);
      return null;
    }
    curAdvance(cur, ind);
    const ch = curPeek(cur);
    if (ch === '-' || ch === '+' || ch === '*') {
      curAdvance(cur, 1);
      const after = curPeek(cur);
      if (after !== ' ' && after !== '\t' && after !== '') {
        curRestore(cur, save);
        return null;
      }
      return { bullet: ch, ordered: false, start: 1, delim: '', width: 1, indent: ind };
    }
    if (ch >= '0' && ch <= '9') {
      let num = '';
      while (curPeek(cur) >= '0' && curPeek(cur) <= '9' && num.length < 9) {
        num += curPeek(cur);
        curAdvance(cur, 1);
      }
      const d = curPeek(cur);
      if ((d === '.' || d === ')') && num.length > 0) {
        curAdvance(cur, 1);
        const after = curPeek(cur);
        if (after !== ' ' && after !== '\t' && after !== '') {
          curRestore(cur, save);
          return null;
        }
        return {
          bullet: '',
          ordered: true,
          start: parseInt(num, 10),
          delim: d,
          width: num.length + 1,
          indent: ind,
        };
      }
    }
    curRestore(cur, save);
    return null;
  }

  // Content indent for a list item, given the cursor just past the marker.
  // Returns the number of columns to consume after the marker (0 when the
  // rest of the line is blank, meaning content indent is marker width + 1).
  function listContentIndent(cur, markerWidth) {
    if (curBlank(cur)) return 1;
    // Measure the whitespace run after the marker.
    let i = cur.i;
    let col = cur.col;
    let partial = cur.partial;
    let w = 0;
    const s = cur.s;
    while (i < s.length) {
      const ch = s[i];
      if (ch === ' ') {
        i++;
        col++;
        w++;
      } else if (ch === '\t') {
        const tw = partial > 0 ? partial : 4 - (col % 4);
        w += tw;
        col += tw;
        i++;
        partial = 0;
      } else break;
      if (w >= 5) break;
    }
    if (w >= 5) return 1;
    return w === 0 ? -1 : w;
  }

  // HTML block start. Returns { kind, end } or null. kind 1-5 end at a
  // marker, 6/7 end at a blank line. `end` is the marker to look for.
  function matchHtmlBlock(cur) {
    const save = curSave(cur);
    const ind = curMeasureIndent(cur, 4);
    if (ind >= 4) {
      curRestore(cur, save);
      return null;
    }
    curAdvance(cur, ind);
    if (curPeek(cur) !== '<') {
      curRestore(cur, save);
      return null;
    }
    const rest = curRest(cur);
    const low = rest.toLowerCase();
    let m;
    // Type 1: script, pre, style, textarea
    m = /^<(script|pre|style|textarea)(?=[\s>]|$)/.exec(low);
    // On success the cursor is restored to the line start, so the block
    // keeps its leading whitespace (` <div>` renders with the space).
    if (m) {
      curRestore(cur, save);
      return { kind: 1, end: '</' + m[1] };
    }
    // Type 2: comment
    if (low.startsWith('<!--')) {
      curRestore(cur, save);
      return { kind: 2, end: '-->' };
    }
    // Type 3: processing instruction
    if (low.startsWith('<?')) {
      curRestore(cur, save);
      return { kind: 3, end: '?>' };
    }
    // Type 4: declaration
    if (/^<![a-z]/.test(low)) {
      curRestore(cur, save);
      return { kind: 4, end: '>' };
    }
    // Type 5: CDATA
    if (low.startsWith('<![cdata[')) {
      curRestore(cur, save);
      return { kind: 5, end: ']]>' };
    }
    // Type 6: block-level tag, open or close (tag may be incomplete)
    m = /^<\/?([a-z][a-z0-9-]*)(?:$|[\s/>])/.exec(low);
    if (m && BLOCK_TAGS.has(m[1])) {
      curRestore(cur, save);
      return { kind: 6, end: null };
    }
    // Type 7: a complete open or closing tag alone on the line
    // (validated with the same tag parser as inline raw HTML).
    const tagEnd = parseTag(rest, 0);
    if (tagEnd > 0 && /^[ \t]*$/.test(rest.slice(tagEnd))) {
      curRestore(cur, save);
      return { kind: 7, end: null };
    }
    curRestore(cur, save);
    return null;
  }

  function htmlBlockEnds(line, kind, end) {
    const low = line.toLowerCase();
    if (kind === 1) {
      // </script, </pre, </style, </textarea followed by space, tab, > or EOL
      let idx = low.indexOf(end);
      while (idx >= 0) {
        const after = low[idx + end.length];
        if (
          after === undefined ||
          after === ' ' ||
          after === '\t' ||
          after === '>'
        ) {
          return true;
        }
        idx = low.indexOf(end, idx + 1);
      }
      return false;
    }
    if (kind === 4) return low.indexOf('>') >= 0;
    return low.indexOf(end) >= 0;
  }

  function processLine(raw, lineIdx, nextIsBlank) {
    const cur = { s: raw, i: 0, col: 0, partial: 0 };
    let lineMatchedQuote = false;

    // 1. Match open containers.
    let container = doc;
    let allMatched = true;
    while (true) {
      const last = lastOpenChild(container);
      if (!last) break;
      if (last.t === 'blockquote') {
        const save = curSave(cur);
        const ind = curMeasureIndent(cur, 4);
        if (ind <= 3) {
          curAdvance(cur, ind);
          if (curPeek(cur) === '>') {
            curAdvance(cur, 1);
            if (curPeek(cur) === ' ' || curPeek(cur) === '\t') {
              curAdvance(cur, 1);
            }
            lineMatchedQuote = true;
            container = last;
            continue;
          }
        }
        curRestore(cur, save);
        allMatched = false;
        break;
      } else if (last.t === 'list') {
        // A list matches only when the line fits its last open item or
        // starts a new item with the same marker; otherwise the list is
        // closed by this line. A thematic break takes precedence over a
        // list marker, so it never matches the list.
        const item = lastOpenChild(last);
        if (item) {
          if (curBlank(cur)) {
            container = last;
            continue;
          }
          // An empty item that has seen a blank line cannot take
          // indented content afterwards (`-\n\n  foo` leaves `foo`
          // outside the list); a non-empty item can.
          const ind = curMeasureIndent(cur, item.contentIndent);
          if (
            ind >= item.contentIndent &&
            !(item.children.length === 0 && item.sawBlank)
          ) {
            container = last;
            continue;
          }
        }
        const save = curSave(cur);
        const isTb = matchThematicBreak(cur);
        curRestore(cur, save);
        if (isTb) {
          allMatched = false;
          break;
        }
        const lm = matchListMarker(cur);
        curRestore(cur, save);
        if (
          lm &&
          lm.ordered === last.ordered &&
          lm.bullet === last.bullet &&
          lm.delim === last.delim
        ) {
          container = last;
          continue;
        }
        allMatched = false;
        break;
      } else if (last.t === 'item') {
        if (curBlank(cur)) {
          container = last;
          continue;
        }
        const ind = curMeasureIndent(cur, last.contentIndent);
        if (
          ind >= last.contentIndent &&
          !(last.children.length === 0 && last.sawBlank)
        ) {
          curAdvance(cur, last.contentIndent);
          container = last;
          continue;
        }
        allMatched = false;
        break;
      } else {
        // The last open child is a leaf (paragraph, code, html, ...):
        // the walk stops here; the tip is that leaf.
        break;
      }
    }

    const blank = curBlank(cur);

    // 2. Blank line.
    if (blank) {
      // A `>  ` line inside an open paragraph adds its space to the
      // paragraph instead of ending it (`> foo\n>  ` gives `foo\n `).
      if (
        lineMatchedQuote &&
        curRest(cur) !== '' &&
        tip !== doc &&
        tip.t === 'paragraph'
      ) {
        if (tip.lazyRun) {
          tip.lines.push('');
          tip.lazyRun = false;
        }
        tip.lines.push(curRest(cur));
        tip.lazyPrevGt = lineMatchedQuote;
        return;
      }
      // An empty `>` line does not set `blankPending`: it is an empty
      // line inside the quote, not a blank line between blocks — except
      // when it ends a paragraph that is a direct child of a list item,
      // in which case the next block in that item starts after a blank
      // line (so the item has two blocks and the list is loose).
      if (
        !lineMatchedQuote ||
        (tip !== doc &&
          tip.t === 'paragraph' &&
          tip.parent &&
          tip.parent.t === 'item')
      ) {
        blankPending = true;
      }
      // A blank line that does not match a `>` closes the enclosing
      // blockquote and everything inside it: a blank line inside an
      // indented code block in a quote is not code content, and a
      // paragraph in the quote ends with the quote.
      let closedQuote = false;
      if (!lineMatchedQuote) {
        let node = tip;
        while (node && node !== doc) {
          if (node.t === 'blockquote') {
            closeTo(node.parent);
            closedQuote = true;
            break;
          }
          if (node.t === 'list' || node.t === 'item') break;
          node = node.parent;
        }
      }
      if (!closedQuote) {
        if (tip !== doc && tip.t === 'paragraph') {
          const b = tip;
          tip = tip.parent;
          finalize(b);
        } else if (tip !== doc && tip.t === 'code' && tip.fenced) {
          // A whitespace-only line is content: keep it (minus the fence
          // indent), so `` ```\n\n  \n``` `` renders `\n  \n`.
          tip.lines.push(stripIndent(curRest(cur), tip.fenceIndent, cur.col));
        } else if (tip !== doc && tip.t === 'code' && !tip.fenced) {
          // A whitespace-only line keeps the spaces beyond the 4-column
          // indent (`      ` inside indented code is `  `, not empty).
          const ind = curMeasureIndent(cur, 4);
          curAdvance(cur, Math.min(ind, 4));
          tip.lines.push(curRest(cur));
        } else if (tip !== doc && tip.t === 'html') {
          if (tip.kind <= 5) {
            tip.lines.push('');
            tip.lastLineIdx = lineIdx;
          } else if (
            tip.lines.length === 1 &&
            tip.startLineEndsWithTag &&
            !nextIsBlank
          ) {
            // A blank line right after an incomplete opening tag is part of
            // the tag, but only when a non-blank line follows it.
            tip.lines.push('');
            tip.lastLineIdx = lineIdx;
            tip.startLineEndsWithTag = false;
          } else {
            const b = tip;
            tip = tip.parent;
            finalize(b);
          }
        }
      }
      // Mark a blank line seen by the innermost enclosing item (for
      // loose/tight lists). A blank line inside a nested list or
      // blockquote does not make the outer list loose, a blank line with
      // container marks (for example `  >`) is inside that container,
      // and a blank line inside a code or raw-HTML block is content.
      const rawIsBlank = /^[ \t]*$/.test(raw);
      if (
        rawIsBlank &&
        !(tip !== doc && tip.t === 'code') &&
        !(tip !== doc && tip.t === 'html' && tip.kind <= 5)
      ) {
        let node = tip;
        while (node && node !== doc) {
          if (node.t === 'item') {
            node.sawBlank = true;
            break;
          }
          node = node.parent;
        }
      }
      return;
    }

    // 3. Lazy continuation, or a new block that interrupts the paragraph.
    if (!allMatched && tip.t === 'paragraph') {
      // Does the line start a block that can interrupt a paragraph?
      const save = curSave(cur);
      let interrupts = false;
      const fence = matchFence(cur);
      curRestore(cur, save);
      if (fence) interrupts = true;
      if (!interrupts && matchAtx(cur) > 0) interrupts = true;
      curRestore(cur, save);
      if (!interrupts) {
        const h = matchHtmlBlock(cur);
        curRestore(cur, save);
        if (h && h.kind <= 6) interrupts = true;
      }
      if (!interrupts && matchThematicBreak(cur)) interrupts = true;
      curRestore(cur, save);
      if (!interrupts) {
        const lm = matchListMarker(cur);
        curRestore(cur, save);
        if (lm) interrupts = true;
      }
      if (!interrupts && curPeek(cur) === '>') {
        const ind = curMeasureIndent(cur, 4);
        if (ind <= 3) interrupts = true;
      }
      if (!interrupts) {
        // Lazy continuation. A lazy line indented by 4+ columns loses 4
        // columns, but only when it directly follows a `>` line or another
        // such indented lazy line (a "run"); when the run ends, a blank
        // line appears in the paragraph before the next line.
        const ind = curMeasureIndent(cur, 4);
        if (ind >= 4 && (tip.lazyPrevGt || tip.lazyRun)) {
          curAdvance(cur, 4);
          tip.lines.push(curRest(cur));
          tip.lazyRun = true;
          tip.lazyPrevGt = false;
        } else {
          if (tip.lazyRun) {
            tip.lines.push('');
            tip.lazyRun = false;
          }
          // A lazy line inside a list item loses its leading whitespace
          // up to the item's content indent (`    - e` in an item with
          // content indent 5 becomes `- e`).
          let anc = tip.parent;
          while (anc && anc !== doc) {
            if (anc.t === 'item') {
              const strip = curMeasureIndent(cur, anc.contentIndent);
              if (strip > 0) curAdvance(cur, strip);
              break;
            }
            anc = anc.parent;
          }
          let lineText = curRest(cur);
          // A lazy setext underline that is a direct child of a blockquote
          // gets 4 spaces prepended when it follows another lazy line
          // (a marked quirk: it keeps the underline from becoming a
          // heading in the quote's inner text).
          if (
            tip.parent.t === 'blockquote' &&
            !tip.lazyPrevGt &&
            isSetextUnderlineLine(lineText)
          ) {
            lineText = '    ' + lineText.replace(/^[ \t]+/, '');
          }
          tip.lines.push(lineText);
          tip.lazyPrevGt = false;
        }
        blankPending = false;
        return;
      }
    }

    // 4-5. Close unmatched blocks, then start / continue blocks. This loops:
    // consuming a blockquote or list marker re-enters the checks for the
    // rest of the line, which may itself be another block (a heading, a
    // fenced code block, an indented code block, ...).
    let firstPass = true;
    while (true) {
      if (firstPass) {
        firstPass = false;
        // 5a. Continue an open leaf that cannot be interrupted (only when
        // every container matched, so the line is in the leaf's container).
        if (allMatched) {
          if (tip.t === 'code' && tip.fenced) {
            const save = curSave(cur);
            const ind = curMeasureIndent(cur, 4);
            let closing = false;
            if (ind <= 3) {
              curAdvance(cur, ind);
              if (curPeek(cur) === tip.fenceCh) {
                let n = 0;
                while (curPeek(cur) === tip.fenceCh) {
                  curAdvance(cur, 1);
                  n++;
                }
                if (n >= tip.fenceLen && curBlank(cur)) closing = true;
              }
            }
            curRestore(cur, save);
            if (closing) {
              const b = tip;
              tip = tip.parent;
              finalize(b);
              blankPending = false;
              return;
            }
            const line = curRest(cur);
            tip.lines.push(stripIndent(line, tip.fenceIndent, cur.col));
            blankPending = false;
            return;
          }
          if (tip.t === 'code' && !tip.fenced) {
            const ind = curMeasureIndent(cur, 4);
            if (ind >= 4) {
              curAdvance(cur, 4);
              tip.lines.push(curRest(cur));
              blankPending = false;
              return;
            }
            // Not indented: close the code block and reprocess this line.
            const b = tip;
            tip = tip.parent;
            finalize(b);
            processLine(raw, lineIdx, nextIsBlank);
            return;
          }
          if (tip.t === 'html') {
            const line = curRest(cur);
            tip.lines.push(line);
            tip.lastLineIdx = lineIdx;
            if (tip.kind === 1 && htmlBlockEnds(line, 1, tip.end)) {
              tip.endedAtMarker = true;
              tip.followedByBlank = lineIdx < lastLineIdx && nextIsBlank;
              const b = tip;
              tip = tip.parent;
              finalize(b);
            } else if (
              tip.kind >= 2 &&
              tip.kind <= 5 &&
              htmlBlockEnds(line, tip.kind, tip.end)
            ) {
              tip.endedAtMarker = true;
              tip.followedByBlank = lineIdx < lastLineIdx && nextIsBlank;
              const b = tip;
              tip = tip.parent;
              finalize(b);
            }
            blankPending = false;
            return;
          }
        }
        // 4. Close unmatched blocks (only when some container failed to
        // match; when every container matched, the open leaf stays open
        // until a new block starts it).
        if (!allMatched) closeTo(container);
      }

    // 5b. New block starts.
    // Setext heading (only when the paragraph is still open here).
    if (tip.t === 'paragraph') {
      const setextSave = curSave(cur);
      const lvl = matchSetext(cur);
      if (lvl > 0) {
        // If the paragraph holds a table, it is a table, not a heading.
        const lines = tip.lines.join('\n');
        const stripped = stripLinkRefDefs(lines, refs);
        if (stripped !== '' && findTableStart(stripped.split('\n')) < 0) {
          const para = tip;
          tip = tip.parent;
          // A setext heading's content is the paragraph's text with
          // leading / trailing whitespace removed.
          const text = stripped.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
          const head = {
            t: 'heading',
            level: lvl,
            lines: text.split('\n'),
            parent: para.parent,
            open: false,
          };
          const ch = para.parent.children;
          ch[ch.indexOf(para)] = head;
          blankPending = false;
          return;
        }
        // Not a heading (the paragraph is all definitions, or holds a
        // table): put the cursor back so the line is processed normally
        // (a `---` becomes a thematic break, an `===` joins the paragraph).
        curRestore(cur, setextSave);
      }
    }

    const fence = matchFence(cur);
    if (fence) {
      if (tip.t === 'paragraph') {
        const b = tip;
        tip = tip.parent;
        finalize(b);
      }
      const node = addChild(container, {
        t: 'code',
        fenced: true,
        info: fence.info,
        fenceCh: fence.ch,
        fenceLen: fence.len,
        fenceIndent: fence.indent,
        lines: [],
      });
      tip = node;
      blankPending = false;
      return;
    }

    const atx = matchAtx(cur);
    if (atx > 0) {
      if (tip.t === 'paragraph') {
        const b = tip;
        tip = tip.parent;
        finalize(b);
      }
      const node = addChild(container, {
        t: 'heading',
        level: atx,
        lines: [atxContent(cur)],
      });
      tip = node.parent;
      finalize(node);
      blankPending = false;
      return;
    }

    const html = matchHtmlBlock(cur);
    if (html && (html.kind <= 6 || tip.t !== 'paragraph')) {
      if (tip.t === 'paragraph') {
        const b = tip;
        tip = tip.parent;
        finalize(b);
      }
      const startLine = curRest(cur);
      const node = addChild(container, {
        t: 'html',
        kind: html.kind,
        end: html.end,
        startLineEndsWithTag:
          html.kind === 6 &&
          /^[ \t]*<\/?[a-z][a-z0-9-]*$/.test(startLine),
        lines: [startLine],
        lastLineIdx: lineIdx,
        endedAtMarker: false,
      });
      tip = node;
      if (html.kind === 1 && htmlBlockEnds(startLine, 1, html.end)) {
        node.endedAtMarker = true;
        node.followedByBlank = lineIdx < lastLineIdx && nextIsBlank;
        tip = tip.parent;
        finalize(node);
      } else if (
        html.kind >= 2 &&
        html.kind <= 5 &&
        htmlBlockEnds(startLine, html.kind, html.end)
      ) {
        node.endedAtMarker = true;
        node.followedByBlank = lineIdx < lastLineIdx && nextIsBlank;
        tip = tip.parent;
        finalize(node);
      }
      blankPending = false;
      return;
    }

    if (matchThematicBreak(cur)) {
      if (tip.t === 'paragraph') {
        const b = tip;
        tip = tip.parent;
        finalize(b);
      }
      const node = addChild(container, { t: 'thematic_break' });
      tip = node.parent;
      finalize(node);
      blankPending = false;
      return;
    }

    const lmSave = curSave(cur);
    const lm = matchListMarker(cur);
    if (lm) {
      // An empty item cannot interrupt a paragraph (`*foo bar\n*` keeps
      // the `*` in the paragraph); an ordered list interrupts one only
      // when it starts with 1, except inside a list item, where any
      // start number begins a nested list (`- foo\n  2. bar`).
      const canInterrupt =
        tip.t !== 'paragraph'
          ? true
          : !curBlank(cur) &&
              (!lm.ordered ||
                lm.start === 1 ||
                (tip.parent && tip.parent.t === 'item'));
      if (canInterrupt) {
        if (tip.t === 'paragraph') {
          const b = tip;
          tip = tip.parent;
          finalize(b);
        }
        // Find or start the list. When the last matched container is a
        // list with the same marker, the item joins it; otherwise a new
        // list starts as a child of the container.
        let list = null;
        if (
          container.t === 'list' &&
          container.ordered === lm.ordered &&
          container.bullet === lm.bullet &&
          container.delim === lm.delim
        ) {
          list = container;
        } else {
          list = addChild(container, {
            t: 'list',
            ordered: lm.ordered,
            bullet: lm.bullet,
            delim: lm.delim,
            start: lm.start,
            tight: true,
          });
        }
        // Content indent: columns from the container's content start to
        // the item's content start.
        const w = listContentIndent(cur, lm.width);
        const contentIndent =
          w < 0 ? lm.indent + lm.width + 1 : lm.indent + lm.width + w;
        const item = addChild(list, {
          t: 'item',
          contentIndent,
        });
        tip = item;
        if (w >= 0) {
          curAdvance(cur, w);
        }
        // The rest of the line (if any) is processed as a new block
        // inside the item.
        if (curBlank(cur)) {
          blankPending = false;
          return;
        }
        container = item;
        continue;
      } else {
        // The marker does not start a list here: put the cursor back so
        // the line keeps its marker text in the paragraph.
        curRestore(cur, lmSave);
      }
    }

    // Blockquote.
    {
      const save = curSave(cur);
      const ind = curMeasureIndent(cur, 4);
      if (ind <= 3) {
        curAdvance(cur, ind);
        if (curPeek(cur) === '>') {
          if (tip.t === 'paragraph') {
            const b = tip;
            tip = tip.parent;
            finalize(b);
          }
          curAdvance(cur, 1);
          if (curPeek(cur) === ' ' || curPeek(cur) === '\t') {
            curAdvance(cur, 1);
          }
          const node = addChild(container, { t: 'blockquote' });
          tip = node;
          // The rest of the line (if any) is processed as a new block
          // inside the quote.
          if (curBlank(cur)) {
            blankPending = false;
            return;
          }
          container = node;
          lineMatchedQuote = true;
          continue;
        }
      }
      curRestore(cur, save);
    }

    // Indented code (cannot interrupt a paragraph).
    if (tip.t !== 'paragraph') {
      const ind = curMeasureIndent(cur, 4);
      if (ind >= 4) {
        curAdvance(cur, 4);
        const node = addChild(container, {
          t: 'code',
          fenced: false,
          lines: [curRest(cur)],
        });
        tip = node;
        blankPending = false;
        return;
      }
    }

    // Continue the open paragraph, or start a new one.
    if (tip.t === 'paragraph') {
      if (tip.lazyRun) {
        tip.lines.push('');
        tip.lazyRun = false;
      }
      tip.lines.push(curRest(cur));
      tip.lazyPrevGt = lineMatchedQuote;
      blankPending = false;
      return;
    }
    // Start a new paragraph.
    const para = addChild(container, { t: 'paragraph', lines: [] });
    para.lines.push(curRest(cur));
    para.lazyPrevGt = lineMatchedQuote;
    tip = para;
    blankPending = false;
    return;
    }
  }

  function isBlankLine(s) {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch !== ' ' && ch !== '\t') return false;
    }
    return true;
  }

  const lastLineIdx = rawLines.length - 1;
  for (let li = 0; li < rawLines.length; li++) {
    const nextIsBlank =
      li + 1 < rawLines.length ? isBlankLine(rawLines[li + 1]) : true;
    processLine(rawLines[li], li, nextIsBlank);
  }
  closeTo(doc);
  return { doc, refs, srcEndsNL };
}

// Remove up to `n` columns of leading whitespace from a line string.
function stripIndent(line, n, startCol) {
  let i = 0;
  let col = startCol || 0;
  while (n > 0 && i < line.length) {
    const ch = line[i];
    if (ch === ' ') {
      i++;
      col++;
      n--;
    } else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (w > n) {
        return ' '.repeat(w - n) + line.slice(i + 1);
      }
      i++;
      col += w;
      n -= w;
    } else break;
  }
  // Inside a container (startCol > 0) a leading tab is expanded to
  // spaces from its absolute column (`> \tfoo` gives `  foo`, a tab
  // at column 13 gives 3 spaces). At the document level a leading
  // tab is kept as-is (` ```\n\tfoo` stays `\tfoo`).
  if (startCol > 0 && i < line.length && line[i] === '\t') {
    const w = 4 - (col % 4);
    return ' '.repeat(w) + line.slice(i + 1);
  }
  return line.slice(i);
}

// ---------------------------------------------------------------------------
// Link reference definitions and GFM tables.
// ---------------------------------------------------------------------------

function normalizeLabel(label) {
  // Unicode case folding: `ß` / `ẞ` fold to `ss` (so `[ẞ]` matches
  // `[SS]: /url`).
  return label
    .replace(/[ \t\n]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ß/g, 'ss');
}

// Skip spaces/tabs, then optionally one newline plus all leading
// whitespace on the next line (a destination or title on the next line
// may be indented by any amount).
function skipWsAndOneNewline(text, j) {
  const n = text.length;
  while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
  if (j < n && text[j] === '\n') {
    j++;
    while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
  }
  return j;
}

// Parse a link reference definition starting at `pos` (a line start).
// Returns { label, dest, title, end } or null.
// Parse a link title starting at `i` (text[i] is `"`, `'` or `(`).
// A title may span lines. Returns { title, end } (end is the index after
// the closing quote) or null.
function parseRefTitle(text, i) {
  const n = text.length;
  const closer = text[i] === '(' ? ')' : text[i];
  let j = i + 1;
  let t = '';
  while (j < n) {
    const ch = text[j];
    if (ch === '\\' && j + 1 < n && isAsciiPunctCh(text[j + 1])) {
      t += text[j + 1];
      j += 2;
    } else if (ch === closer) {
      return { title: t, end: j + 1 };
    } else {
      t += ch;
      j++;
    }
  }
  return null;
}

function tryParseRefDef(text, pos) {
  const n = text.length;
  let i = pos;
  let col = 0;
  while (i < n && col < 3) {
    const ch = text[i];
    if (ch === ' ') {
      i++;
      col++;
    } else if (ch === '\t') {
      col += 4 - (col % 4);
      if (col > 3) break;
      i++;
    } else break;
  }
  if (i >= n || text[i] !== '[') return null;
  // Label: no unescaped `[` (that makes the definition invalid). A
  // backslash stays part of the label, so `[ref\[]` defines `ref\[`
  // and `[foo!]` does not match `[bar][foo\!]`.
  let j = i + 1;
  let label = '';
  let closed = false;
  while (j < n) {
    const ch = text[j];
    if (ch === '\\' && j + 1 < n && isAsciiPunctCh(text[j + 1])) {
      label += ch + text[j + 1];
      j += 2;
    } else if (ch === '[') {
      return null;
    } else if (ch === ']') {
      closed = true;
      j++;
      break;
    } else if (ch === '\n') {
      label += ' ';
      j++;
    } else {
      label += ch;
      j++;
    }
  }
  if (!closed) return null;
  if (j >= n || text[j] !== ':') return null;
  j++;
  j = skipWsAndOneNewline(text, j);
  // Destination.
  let dest = '';
  if (j < n && text[j] === '<') {
    j++;
    let closed = false;
    while (j < n) {
      const ch = text[j];
      if (ch === '>') {
        j++;
        closed = true;
        break;
      }
      if (ch === '\n' || ch === '<') return null;
      if (ch === '\\' && j + 1 < n && isAsciiPunctCh(text[j + 1])) {
        dest += text[j + 1];
        j += 2;
      } else {
        dest += ch;
        j++;
      }
    }
    if (!closed) return null;
  } else {
    let pdepth = 0;
    while (j < n) {
      const ch = text[j];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 32) {
        break;
      }
      if (ch === '\\' && j + 1 < n && isAsciiPunctCh(text[j + 1])) {
        dest += text[j + 1];
        j += 2;
      } else if (ch === '(') {
        pdepth++;
        dest += ch;
        j++;
      } else if (ch === ')') {
        if (pdepth === 0) break;
        pdepth--;
        dest += ch;
        j++;
      } else {
        dest += ch;
        j++;
      }
    }
    if (dest === '' || pdepth !== 0) return null;
  }
  // Optional title: on the same line as the destination, or on the next
  // line. After it, only spaces/tabs, then a newline or end of text.
  // (The newline after the destination is not swallowed before this
  // check, so a definition followed by another definition still parses.)
  let title = null;
  let p = j;
  while (p < n && (text[p] === ' ' || text[p] === '\t')) p++;
  let end;
  if (
    p > j &&
    p < n &&
    (text[p] === '"' || text[p] === "'" || text[p] === '(')
  ) {
    // Title on the same line: there must be whitespace between the
    // destination and the title (`[foo]: <bar>(baz)` is not a definition).
    // A title followed by junk invalidates the whole definition.
    const t = parseRefTitle(text, p);
    if (!t) return null;
    title = t.title;
    let q = t.end;
    while (q < n && (text[q] === ' ' || text[q] === '\t')) q++;
    if (q < n && text[q] !== '\n') return null;
    end = q < n ? q + 1 : q;
  } else if (p < n && text[p] === '\n') {
    let r = p + 1;
    while (r < n && (text[r] === ' ' || text[r] === '\t')) r++;
    if (r < n && (text[r] === '"' || text[r] === "'" || text[r] === '(')) {
      const t = parseRefTitle(text, r);
      let ok = false;
      if (t) {
        let q = t.end;
        while (q < n && (text[q] === ' ' || text[q] === '\t')) q++;
        if (q >= n || text[q] === '\n') {
          title = t.title;
          end = q < n ? q + 1 : q;
          ok = true;
        }
      }
      if (!ok) {
        // A title on the next line that is malformed or followed by junk
        // does not kill the definition: the definition ends at the
        // newline after the destination, and the line stays as text.
        end = p + 1;
      }
    } else {
      // No title; the definition ends at the newline.
      end = p + 1;
    }
  } else if (p >= n) {
    end = p;
  } else {
    return null;
  }
  const norm = normalizeLabel(label);
  if (norm === '') return null;
  return { label: norm, dest, title, end };
}

// Strip leading link reference definitions from a paragraph's text,
// recording them in `refs` (first definition wins).
function stripLinkRefDefs(text, refs) {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    const def = tryParseRefDef(text, pos);
    if (!def) break;
    if (!refs.has(def.label)) {
      refs.set(def.label, { dest: def.dest, title: def.title });
    }
    pos = def.end;
  }
  return text.slice(pos);
}

// Split a table row line into cells on unescaped pipes.
function splitTableRow(line) {
  let s = line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) {
    let bs = 0;
    for (let i = s.length - 2; i >= 0 && s[i] === '\\'; i--) bs++;
    if (bs % 2 === 0) s = s.slice(0, -1);
  }
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && s[i + 1] === '|') {
      // An escaped pipe: it does not split the row, and the escape is
      // resolved here (so `` `\|` `` renders as `<code>|</code>`).
      cur += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  }
  return cells;
}

// Parse a delimiter row; returns the alignment list or null.
function parseDelimiterRow(line) {
  const cells = splitTableRow(line);
  const aligns = [];
  for (const c of cells) {
    const t = c.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    if (t.startsWith(':') && t.endsWith(':')) aligns.push('center');
    else if (t.endsWith(':')) aligns.push('right');
    else if (t.startsWith(':')) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

// Is this line a setext heading underline (`=` or `--`) with at most
// 3 columns of leading whitespace? A `-` underline here is exactly two
// dashes: a single `-` is a list marker and three or more dashes are a
// thematic break, and neither reaches a lazy continuation.
function isSetextUnderlineLine(line) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ') {
      col++;
      i++;
    } else if (ch === '\t') {
      col += 4 - (col % 4);
      i++;
    } else break;
  }
  if (col > 3) return false;
  const rest = line.slice(i).replace(/[ \t]+$/, '');
  return /^=+$/.test(rest) || rest === '--';
}

// Columns of leading whitespace of a line string (tab-aware).
function lineIndentCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Find the first table start in a paragraph's lines, or -1. The header
// and delimiter lines may be indented by at most 3 columns.
function findTableStart(lines) {
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lineIndentCols(lines[i]) > 3 || lineIndentCols(lines[i + 1]) > 3) {
      continue;
    }
    const headerCells = splitTableRow(lines[i]);
    const aligns = parseDelimiterRow(lines[i + 1]);
    if (aligns && aligns.length === headerCells.length) return i;
  }
  return -1;
}

function makeTable(lines) {
  const headerCells = splitTableRow(lines[0]);
  const aligns = parseDelimiterRow(lines[1]);
  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    rows.push(splitTableRow(lines[i]));
  }
  return { t: 'table', headerCells, aligns, rows, open: false };
}

// ---------------------------------------------------------------------------
// Inline parsing: one scan builds nodes + delimiters + brackets, then the
// delimiter stack resolves emphasis / strong / strikethrough.
// ---------------------------------------------------------------------------

function isLocalPartCh(ch) {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    '.!#$%&\'*+/=?^_`{|}~-'.indexOf(ch) >= 0
  );
}

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]*[a-zA-Z0-9])+(?![a-zA-Z0-9-])/;

function isEmailAutolink(content) {
  return EMAIL_RE.test(content);
}

// Parse a raw HTML tag starting at `i` (s[i] === '<'). Returns the end
// index (exclusive) or -1.
// Parse a single HTML open/close tag starting at `i` (s[i] === '<').
// Returns the end index (exclusive) or -1. Attribute names must be
// valid (`[a-zA-Z_:][a-zA-Z0-9_.:-]*`), an attribute must be preceded
// by whitespace (so `<m:abc>` and `<a href='bar'title=...>` are not
// tags), and a closing tag takes no attributes (`</a href="x">` is
// not a tag). A quoted value ends at the next quote character (there
// is no backslash escaping in HTML), so `<a href="\"">` is not a tag.
function parseTag(s, i) {
  const n = s.length;
  let j = i + 1;
  let closing = false;
  if (j < n && s[j] === '/') {
    closing = true;
    j++;
  }
  const m = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(s.slice(j));
  if (!m) return -1;
  j += m[0].length;
  if (closing) {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    return j < n && s[j] === '>' ? j + 1 : -1;
  }
  // After the tag name only whitespace, '/' or '>' may follow.
  if (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '/' && s[j] !== '>') {
    return -1;
  }
  while (j < n) {
    const ch = s[j];
    if (ch === '>') return j + 1;
    if (ch === '/' && j + 1 < n && s[j + 1] === '>') return j + 2;
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      j++;
      continue;
    }
    // Attribute name. Right after the name only whitespace, '=', '/'
    // or '>' may follow (so `<a href='bar'title=...>` is not a tag,
    // while `_boolean zoop:33=...` is: the space was skipped while
    // looking for `=`).
    const am = /^[a-zA-Z_:][a-zA-Z0-9_.:-]*/.exec(s.slice(j));
    if (!am) return -1;
    j += am[0].length;
    if (
      j < n &&
      s[j] !== ' ' &&
      s[j] !== '\t' &&
      s[j] !== '\n' &&
      s[j] !== '=' &&
      s[j] !== '/' &&
      s[j] !== '>'
    ) {
      return -1;
    }
    // Optional whitespace, =, value.
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j < n && s[j] === '=') {
      j++;
      while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (j < n && (s[j] === '"' || s[j] === "'")) {
        const q = s[j];
        j++;
        while (j < n && s[j] !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        let k = j;
        while (
          k < n &&
          s[k] !== ' ' &&
          s[k] !== '\t' &&
          s[k] !== '\n' &&
          s[k] !== '"' &&
          s[k] !== "'" &&
          s[k] !== '=' &&
          s[k] !== '<' &&
          s[k] !== '>' &&
          s[k] !== '`'
        ) {
          k++;
        }
        if (k === j) return -1;
        j = k;
      }
      // After a value only whitespace, '/' or '>' may follow.
      if (
        j < n &&
        s[j] !== ' ' &&
        s[j] !== '\t' &&
        s[j] !== '\n' &&
        s[j] !== '/' &&
        s[j] !== '>'
      ) {
        return -1;
      }
    }
  }
  return -1;
}

function parseRawHtml(s, i) {
  const n = s.length;
  const rest = s.slice(i);
  let m;
  if (rest.startsWith('<!--')) {
    // `<!-->` and `<!--->` are complete comments on their own; the
    // text after them is not part of the comment.
    if (rest.startsWith('<!-->')) return i + 5;
    if (rest.startsWith('<!--->')) return i + 6;
    const end = s.indexOf('-->', i + 4);
    return end >= 0 ? end + 3 : -1;
  }
  if (rest.startsWith('<?')) {
    const end = s.indexOf('?>', i + 2);
    return end >= 0 ? end + 2 : -1;
  }
  if (/^<![a-zA-Z]/.test(rest)) {
    const end = s.indexOf('>', i + 2);
    return end >= 0 ? end + 1 : -1;
  }
  if (rest.startsWith('<![CDATA[')) {
    const end = s.indexOf(']]>', i + 9);
    return end >= 0 ? end + 3 : -1;
  }
  return parseTag(s, i);
}

// Parse an inline link destination + optional title starting at `i`
// (s[i] === '('). Returns { dest, title, end } or null.
function parseInlineLinkTail(s, i) {
  const n = s.length;
  let j = i + 1;
  j = skipWsAndOneNewline(s, j);
  if (j >= n) return null;
  let dest = '';
  if (s[j] === '<') {
    j++;
    let closed = false;
    while (j < n) {
      const ch = s[j];
      if (ch === '>') {
        j++;
        closed = true;
        break;
      }
      if (ch === '\n' || ch === '<') return null;
      if (ch === '\\' && j + 1 < n && isAsciiPunctCh(s[j + 1])) {
        dest += s[j + 1];
        j += 2;
      } else {
        dest += ch;
        j++;
      }
    }
    if (!closed) return null;
  } else {
    let pdepth = 0;
    while (j < n) {
      const ch = s[j];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 32) {
        break;
      }
      if (ch === '\\' && j + 1 < n && isAsciiPunctCh(s[j + 1])) {
        dest += s[j + 1];
        j += 2;
      } else if (ch === '(') {
        pdepth++;
        dest += ch;
        j++;
      } else if (ch === ')') {
        if (pdepth === 0) break;
        pdepth--;
        dest += ch;
        j++;
      } else {
        dest += ch;
        j++;
      }
    }
    if (pdepth !== 0) return null;
  }
  j = skipWsAndOneNewline(s, j);
  let title = null;
  if (j < n && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
    const closer = s[j] === '(' ? ')' : s[j];
    j++;
    let ok = false;
    let t = '';
    while (j < n) {
      const ch = s[j];
      if (ch === '\n') return null;
      if (ch === '\\' && j + 1 < n && isAsciiPunctCh(s[j + 1])) {
        t += s[j + 1];
        j += 2;
      } else if (ch === closer) {
        j++;
        ok = true;
        break;
      } else {
        t += ch;
        j++;
      }
    }
    if (!ok) return null;
    title = t;
    j = skipWsAndOneNewline(s, j);
  }
  if (j >= n || s[j] !== ')') return null;
  return { dest, title, end: j + 1 };
}

// Plain text of a node list (for image alt text and shortcut labels).
function nodesPlainText(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.k === 'text') out += node.s;
    else if (node.k === 'raw') out += node.plain;
    else if (node.k === 'code') out += node.s;
    else if (node.k === 'html') out += node.s;
    else if (node.k === 'delim') out += node.ch.repeat(node.len);
    else if (node.k === 'img') out += node.alt;
    else if (
      node.k === 'em' ||
      node.k === 'strong' ||
      node.k === 'del' ||
      node.k === 'link'
    ) {
      out += nodesPlainText(node.children);
    }
  }
  return out;
}

function firstCharOf(nodes) {
  for (const node of nodes) {
    if (node.k === 'text') return node.s.length ? node.s[0] : '';
    if (node.k === 'raw') return node.plain.length ? node.plain[0] : '';
    if (node.k === 'code') return node.s.length ? node.s[0] : '';
    if (node.k === 'html') return node.s.length ? node.s[0] : '';
    if (node.k === 'delim') return node.ch;
    if (node.k === 'img') return node.alt.length ? node.alt[0] : '';
    if (node.k === 'em' || node.k === 'strong' || node.k === 'del' || node.k === 'link') {
      const c = firstCharOf(node.children);
      if (c !== '') return c;
    }
  }
  return '';
}

function lastCharOf(nodes) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.k === 'text') return node.s.length ? node.s[node.s.length - 1] : '';
    if (node.k === 'raw') return node.plain.length ? node.plain[node.plain.length - 1] : '';
    if (node.k === 'code') return node.s.length ? node.s[node.s.length - 1] : '';
    if (node.k === 'html') return node.s.length ? node.s[node.s.length - 1] : '';
    if (node.k === 'delim') return node.ch;
    if (node.k === 'img') return node.alt.length ? node.alt[node.alt.length - 1] : '';
    if (node.k === 'em' || node.k === 'strong' || node.k === 'del' || node.k === 'link') {
      const c = lastCharOf(node.children);
      if (c !== '') return c;
    }
  }
  return '';
}

// Resolve emphasis / strong / strikethrough in a node list (mutates it).
// Closers are processed in the order they appear, so an inner pair (for
// example `__bar__` inside `__foo, __bar__, baz__`) is resolved before
// the outer pair that contains it. When a pair is formed, the delimiters
// between the opener and closer are removed from the stack: they are now
// inside the emphasis node (they were already processed, in order, before
// this closer) and are no longer candidates at this level.
function processEmphasis(nodes, delims) {
  let i = 0;
  while (i < delims.length) {
    const closer = delims[i];
    if (!closer.canClose || closer.len === 0) {
      i++;
      continue;
    }
    let openerIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      const o = delims[j];
      if (o.ch !== closer.ch || !o.canOpen || o.len === 0) continue;
      if (o.ch === '~') {
        if (o.len !== closer.len) continue;
      } else if (
        (o.canClose || closer.canOpen) &&
        (o.len + closer.len) % 3 === 0 &&
        !(o.len % 3 === 0 && closer.len % 3 === 0)
      ) {
        continue;
      }
      openerIdx = j;
      break;
    }
    if (openerIdx === -1) {
      i++;
      continue;
    }
    const opener = delims[openerIdx];
    const openNodeIdx = nodes.indexOf(opener.node);
    const closeNodeIdx = nodes.indexOf(closer.node);
    const children = nodes.slice(openNodeIdx + 1, closeNodeIdx);
    if (opener.ch === '~') {
      const first = firstCharOf(children);
      const last = lastCharOf(children);
      if (
        first === ' ' ||
        first === '\t' ||
        first === '\n' ||
        last === ' ' ||
        last === '\t' ||
        last === '\n'
      ) {
        i++;
        continue;
      }
    }
    const use =
      opener.ch === '~'
        ? opener.len
        : opener.len >= 2 && closer.len >= 2
          ? 2
          : 1;
    const kind = opener.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const emNode = { k: kind, children };
    opener.len -= use;
    closer.len -= use;
    opener.node.len = opener.len;
    closer.node.len = closer.len;
    const repl = [];
    if (opener.len > 0) repl.push(opener.node);
    repl.push(emNode);
    if (closer.len > 0) repl.push(closer.node);
    nodes.splice(openNodeIdx, closeNodeIdx - openNodeIdx + 1, ...repl);
    // Drop the delimiters that are now inside the emphasis node.
    const innerCount = i - openerIdx - 1;
    if (innerCount > 0) delims.splice(openerIdx + 1, innerCount);
    if (opener.len === 0) delims.splice(openerIdx, 1);
    if (closer.len === 0) {
      const ci = delims.indexOf(closer);
      delims.splice(ci, 1);
      i = ci;
    } else {
      // The closer still has length left: re-examine it, so it can match
      // the remaining opener (for example `***foo***` -> em around strong).
      i = delims.indexOf(closer);
    }
  }
  return nodes;
}

// Whether the parser is inside an unclosed `<a>` element. An `<a>`
// open tag (raw HTML) suppresses autolinks until its `</a>`, even
// across paragraphs — this is per-`parse()` state, reset at the start
// of each call, not a cache.
let inAnchor = false;

// The main inline scan. Returns the parsed node list.
function parseInline(s, refs) {
  const nodes = [];
  const delims = [];
  const brackets = [];
  const n = s.length;
  let i = 0;
  let textStart = 0;

  function flushText(upto) {
    if (upto > textStart) nodes.push({ k: 'text', s: s.slice(textStart, upto) });
  }

  function nodeIndexOf(node) {
    return nodes.indexOf(node);
  }

  while (i < n) {
    const ch = s[i];

    // Backslash escape / hard break.
    if (ch === '\\') {
      if (i + 1 < n && s[i + 1] === '\n') {
        flushText(i);
        nodes.push({ k: 'br' });
        i += 2;
        // A hard break strips the leading whitespace of the next line.
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        textStart = i;
        continue;
      }
      if (i + 1 < n && isAsciiPunctCh(s[i + 1])) {
        flushText(i);
        nodes.push({ k: 'text', s: s[i + 1] });
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // Newline: hard break (2+ trailing spaces) or soft break.
    if (ch === '\n') {
      flushText(i);
      const last = nodes.length ? nodes[nodes.length - 1] : null;
      if (last && last.k === 'text' && /  +$/.test(last.s)) {
        last.s = last.s.replace(/ +$/, '');
        nodes.push({ k: 'br' });
        i++;
        // A hard break strips the leading whitespace of the next line.
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        textStart = i;
        continue;
      }
      nodes.push({ k: 'text', s: '\n' });
      i++;
      textStart = i;
      continue;
    }

    // Code span.
    if (ch === '`') {
      let run = 0;
      while (i + run < n && s[i + run] === '`') run++;
      // Find a matching run of the same length.
      let j = i + run;
      let matchEnd = -1;
      let contentEnd = -1;
      while (j < n) {
        if (s[j] === '`') {
          let r2 = 0;
          while (j + r2 < n && s[j + r2] === '`') r2++;
          if (r2 === run) {
            matchEnd = j + r2;
            contentEnd = j;
            break;
          }
          j += r2;
        } else {
          j++;
        }
      }
      if (matchEnd < 0) {
        i += run;
        continue;
      }
      flushText(i);
      let content = s.slice(i + run, contentEnd).replace(/\n/g, ' ');
      if (
        content.length >= 2 &&
        content[0] === ' ' &&
        content[content.length - 1] === ' ' &&
        /[^ ]/.test(content)
      ) {
        content = content.slice(1, -1);
      }
      nodes.push({ k: 'code', s: content });
      i = matchEnd;
      textStart = i;
      continue;
    }

    // Numeric entity (decoded) in regular text.
    if (ch === '&' && i + 1 < n && s[i + 1] === '#') {
      const decoded = decodeNumericEntity(s, i);
      if (decoded) {
        flushText(i);
        nodes.push({
          k: 'raw',
          s: escPlain(decoded.ch),
          plain: decoded.ch,
        });
        i = decoded.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // Delimiter runs: *, _, ~.
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (i + run < n && s[i + run] === ch) run++;
      if (ch === '~' && run > 2) {
        i += run;
        continue;
      }
      flushText(i);
      const prevCh = i > 0 ? s[i - 1] : '';
      const nextCh = i + run < n ? s[i + run] : '';
      const prevWs = prevCh === '' || /\s/.test(prevCh);
      const nextWs = nextCh === '' || /\s/.test(nextCh);
      const prevPunct = prevCh !== '' && isPunctCh(prevCh);
      const nextPunct = nextCh !== '' && isPunctCh(nextCh);
      const leftFlanking = !nextWs && (!nextPunct || prevWs || prevPunct);
      const rightFlanking = !prevWs && (!prevPunct || nextWs || nextPunct);
      let canOpen;
      let canClose;
      if (ch === '_') {
        canOpen = leftFlanking && (!rightFlanking || prevPunct);
        canClose = rightFlanking && (!leftFlanking || nextPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      const node = { k: 'delim', ch, len: run };
      nodes.push(node);
      delims.push({ node, ch, len: run, canOpen, canClose });
      i += run;
      textStart = i;
      continue;
    }

    // Bracket: link / image start.
    if (ch === '[' || (ch === '!' && i + 1 < n && s[i + 1] === '[')) {
      const isImage = ch === '!';
      flushText(i);
      const node = { k: 'text', s: isImage ? '![' : '[' };
      nodes.push(node);
      brackets.push({
        node,
        image: isImage,
        active: true,
        contentStart: i + (isImage ? 2 : 1),
      });
      i += isImage ? 2 : 1;
      textStart = i;
      continue;
    }

    // Bracket: link / image end.
    if (ch === ']') {
      flushText(i);
      if (brackets.length === 0) {
        textStart = i;
        i++;
        continue;
      }
      const bracket = brackets[brackets.length - 1];
      if (!bracket.active) {
        // An inactive bracket is spent: pop it so a later `]` can
        // reach the bracket below it (`![[[foo](uri1)](uri2)](uri3)`).
        brackets.pop();
        textStart = i;
        i++;
        continue;
      }
      // Try to form a link.
      let link = null;
      let endIdx = i + 1;
      if (i + 1 < n && s[i + 1] === '(') {
        const tail = parseInlineLinkTail(s, i + 1);
        if (tail) {
          link = { dest: tail.dest, title: tail.title };
          endIdx = tail.end;
        }
      }
      let hadLabelBracket = false;
      let labelWellFormed = false;
      if (!link && i + 1 < n && s[i + 1] === '[') {
        hadLabelBracket = true;
        // Full / collapsed reference. A label holds no unescaped `[`
        // (that makes the reference invalid), and a backslash stays part
        // of the label, so `[bar][foo\!]` does not match `[foo!]: /url`.
        let j = i + 2;
        let label = '';
        let ok = false;
        while (j < n) {
          const c = s[j];
          if (c === '\\' && j + 1 < n && isAsciiPunctCh(s[j + 1])) {
            label += c + s[j + 1];
            j += 2;
          } else if (c === '[') {
            break;
          } else if (c === ']') {
            ok = true;
            j++;
            break;
          } else if (c === '\n') {
            label += ' ';
            j++;
          } else {
            label += c;
            j++;
          }
        }
        if (ok) {
          labelWellFormed = true;
          let norm = normalizeLabel(label);
          if (norm === '') {
            // Collapsed reference: the label is the link text itself,
            // as raw source text (backslashes and markers kept).
            norm = normalizeLabel(s.slice(bracket.contentStart, i));
          }
          const ref = refs.get(norm);
          if (ref) {
            link = { dest: ref.dest, title: ref.title };
            endIdx = j;
          }
        }
      }
      if (!link && (!hadLabelBracket || !labelWellFormed)) {
        // Shortcut reference: the label is the link text as raw source
        // text (backslashes and emphasis markers kept), so `[*foo*]`
        // only matches a `[*foo*]` definition and `[foo\!]` does not
        // match `[foo!]`. A well-formed `[label]` that failed to match
        // above is a full reference attempt, not a shortcut: `[foo]`
        // in `[foo][bar][baz]` stays literal.
        const norm = normalizeLabel(s.slice(bracket.contentStart, i));
        if (norm !== '') {
          const ref = refs.get(norm);
          if (ref) {
            link = { dest: ref.dest, title: ref.title };
            endIdx = i + 1;
          }
        }
      }
      if (!link) {
        // No link: the ']' is literal text and the bracket is spent.
        brackets.pop();
        textStart = i;
        i++;
        continue;
      }
      // Form the link / image.
      const bracketIdx = nodeIndexOf(bracket.node);
      const children = nodes.slice(bracketIdx + 1);
      // Resolve emphasis inside the link text first.
      const childDelims = [];
      for (let d = delims.length - 1; d >= 0; d--) {
        if (children.indexOf(delims[d].node) >= 0) {
          childDelims.unshift(delims[d]);
          delims.splice(d, 1);
        }
      }
      processEmphasis(children, childDelims);
      let linkNode;
      if (bracket.image) {
        linkNode = {
          k: 'img',
          src: link.dest,
          alt: nodesPlainText(children),
          title: link.title,
        };
      } else {
        linkNode = {
          k: 'link',
          href: link.dest,
          title: link.title,
          children,
        };
      }
      nodes.splice(bracketIdx, nodes.length - bracketIdx, linkNode);
      // Drop the used bracket. A link deactivates the remaining *link*
      // brackets (so a link cannot contain another link), but image
      // brackets stay active, so an image can still wrap or be wrapped:
      // `[![moon](moon.jpg)](/uri)` and `![[[foo](uri1)](uri2)](uri3)`.
      // An image deactivates nothing.
      brackets.pop();
      if (!bracket.image) {
        for (const b of brackets) {
          if (!b.image) b.active = false;
        }
      }
      i = endIdx;
      textStart = i;
      continue;
    }

    // Autolink / raw HTML. A `<...>` autolink is NOT suppressed inside
    // a link's text: it is scanned first and can consume the `](uri)`
    // that would close the outer link (cm-526, cm-538), so it wins.
    if (ch === '<') {
      // Autolink: scan to the next '>' (no space, '<' or newline inside).
      let k = i + 1;
      while (
        k < n &&
        s[k] !== '>' &&
        s[k] !== ' ' &&
        s[k] !== '\t' &&
        s[k] !== '\n' &&
        s[k] !== '<'
      ) {
        k++;
      }
      let auto = null;
      if (k < n && s[k] === '>') {
        const content = s.slice(i + 1, k);
        const m = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):/.exec(content);
        if (m) {
          auto = { href: content, text: content, end: k + 1 };
        } else if (isEmailAutolink(content)) {
          auto = { href: 'mailto:' + content, text: content, end: k + 1 };
        }
      }
      if (auto) {
        flushText(i);
        nodes.push({
          k: 'link',
          href: auto.href,
          title: null,
          children: [{ k: 'text', s: auto.text }],
        });
        i = auto.end;
        textStart = i;
        continue;
      }
      const htmlEnd = parseRawHtml(s, i);
      if (htmlEnd > 0) {
        const tag = s.slice(i, htmlEnd);
        // Track an unclosed `<a>` element: autolinks are suppressed
        // while inside it, even across paragraphs.
        if (
          tag.startsWith('</a') &&
          (tag[3] === '>' ||
            tag[3] === ' ' ||
            tag[3] === '\t' ||
            tag[3] === '\n')
        ) {
          inAnchor = false;
        } else if (
          tag.startsWith('<a') &&
          (tag[2] === '>' ||
            tag[2] === ' ' ||
            tag[2] === '\t' ||
            tag[2] === '\n' ||
            tag[2] === '/') &&
          !tag.endsWith('/>')
        ) {
          inAnchor = true;
        }
        flushText(i);
        nodes.push({ k: 'html', s: tag });
        i = htmlEnd;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // Extended autolink: bare URL. A `<` before the URL allows an
    // `http(s)://` link (`<https://foo.bar/baz`) but not a `www.` link
    // (`<www.foo.bar` stays literal). The scheme is case-insensitive
    // (`Https://...` links too). Suppressed inside a link's text.
    const isWww = s.startsWith('www.', i);
    const isHttp =
      (s[i] === 'h' || s[i] === 'H') &&
      (s.slice(i, i + 7).toLowerCase() === 'http://' ||
        s.slice(i, i + 8).toLowerCase() === 'https://');
    if (
      (isWww || isHttp) &&
      !inAnchor &&
      !brackets.some((b) => !b.image && b.active) &&
      (i === 0 ||
        s[i - 1] === ' ' ||
        s[i - 1] === '\t' ||
        s[i - 1] === '\n' ||
        s[i - 1] === '*' ||
        s[i - 1] === '_' ||
        s[i - 1] === '~' ||
        s[i - 1] === '(' ||
        (isHttp && s[i - 1] === '<'))
    ) {
      const url = scanExtendedUrl(s, i);
      if (url) {
        flushText(i);
        const href = s.startsWith('www.', i) ? 'http://' + url : url;
        nodes.push({
          k: 'link',
          href,
          title: null,
          children: [{ k: 'text', s: url }],
        });
        i += url.length;
        textStart = i;
        continue;
      }
    }

    // Extended autolink: bare email, or a `mailto:` / `xmpp:` + email.
    // Suppressed inside a link's text (links cannot contain links).
    if (
      isLocalPartCh(ch) &&
      (i === 0 || !isLocalPartCh(s[i - 1])) &&
      !inAnchor &&
      !brackets.some((b) => !b.image && b.active)
    ) {
      const hasOpenUnderscore = delims.some(
        (d) => d.ch === '_' && d.canOpen && d.len > 0
      );
      const schemeLink = scanSchemeEmail(s, i, hasOpenUnderscore);
      if (schemeLink !== '') {
        flushText(i);
        nodes.push({
          k: 'link',
          href: schemeLink,
          title: null,
          children: [{ k: 'text', s: schemeLink }],
        });
        i += schemeLink.length;
        textStart = i;
        continue;
      }
      const m = EMAIL_RE.exec(s.slice(i));
      // A `_` right after the email kills the autolink (the `_` would
      // extend the domain label), unless it closes an emphasis that
      // opened before the email (`__foo@bar.baz__` links, `foo@bar.baz_`
      // and `foo@bar.baz__` do not).
      if (m && s[i + m[0].length] === '_' && !hasOpenUnderscore) {
        // Not an autolink: fall through to plain text.
      } else if (m) {
        flushText(i);
        nodes.push({
          k: 'link',
          href: 'mailto:' + m[0],
          title: null,
          children: [{ k: 'text', s: m[0] }],
        });
        i += m[0].length;
        textStart = i;
        continue;
      }
    }

    i++;
  }
  flushText(n);
  processEmphasis(nodes, delims);
  return nodes;
}

// Scan a bare URL for an extended autolink starting at `i`. Returns the
// URL (after paren handling and trailing-punctuation trimming) or ''.
function scanExtendedUrl(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '<') {
    j++;
  }
  let url = s.slice(i, j);
  if (url === '') return '';
  // Paren handling.
  const lastOpen = url.lastIndexOf('(');
  if (lastOpen < 0) {
    url = url.replace(/\)+$/, '');
  } else {
    // Find the ')' matching the last '(' (scan forward with depth).
    let depth = 0;
    let matchIdx = -1;
    for (let k = lastOpen; k < url.length; k++) {
      if (url[k] === '(') depth++;
      else if (url[k] === ')') {
        depth--;
        if (depth === 0) {
          matchIdx = k;
          break;
        }
      }
    }
    if (matchIdx < 0) {
      url = url.slice(0, lastOpen);
    } else {
      // Remove trailing ')'s after the matching ')'.
      let end = url.length;
      while (end > matchIdx + 1 && url[end - 1] === ')') end--;
      url = url.slice(0, end);
    }
  }
  if (url === '') return '';
  return trimExtendedUrlTail(url);
}

// Trailing-punctuation trim for extended autolinks.
function trimExtendedUrlTail(url) {
  const trimChars = '?!.,:*_~(';
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (trimChars.indexOf(last) >= 0) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ';') {
      const m = /&[A-Za-z0-9]+;$/.exec(url);
      if (m) url = url.slice(0, url.length - m[0].length);
      else url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url;
}

// Scan a `mailto:` / `xmpp:` + email extended autolink starting at `i`.
// Only these two schemes take an email; `mailto:` takes no path,
// `xmpp:` takes at most one path segment (`xmpp:foo@bar.baz/txt` but
// not `/txt/bin`). Returns the link text or ''. `hasOpenUnderscore` is
// true when an `_` emphasis delimiter is open before the email, in
// which case a trailing `_` closes it instead of killing the link.
function scanSchemeEmail(s, i, hasOpenUnderscore) {
  let scheme = '';
  if (s.startsWith('mailto:', i)) scheme = 'mailto:';
  else if (s.startsWith('xmpp:', i)) scheme = 'xmpp:';
  else return '';
  const rest = s.slice(i + scheme.length);
  const m = EMAIL_RE.exec(rest);
  if (!m) return '';
  // A `_` right after the email kills the autolink, unless it closes
  // an emphasis that opened before the email.
  if (
    rest[m[0].length] === '_' &&
    !hasOpenUnderscore
  ) {
    return '';
  }
  let link = scheme + m[0];
  if (scheme === 'xmpp:') {
    let j = i + link.length;
    if (j < s.length && s[j] === '/') {
      let k = j + 1;
      while (
        k < s.length &&
        s[k] !== ' ' &&
        s[k] !== '\t' &&
        s[k] !== '\n' &&
        s[k] !== '<' &&
        s[k] !== '/'
      ) {
        k++;
      }
      if (k > j + 1) link = s.slice(i, k);
    }
    link = trimExtendedUrlTail(link);
  }
  return link;
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

function renderInlineNodes(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.k) {
      case 'text':
        out += escNoEncode(node.s);
        break;
      case 'raw':
        out += node.s;
        break;
      case 'code':
        out += '<code>' + escPlain(node.s) + '</code>';
        break;
      case 'br':
        out += '<br>';
        break;
      case 'html':
        out += node.s;
        break;
      case 'delim':
        out += node.ch.repeat(node.len);
        break;
      case 'em':
        out += '<em>' + renderInlineNodes(node.children) + '</em>';
        break;
      case 'strong':
        out += '<strong>' + renderInlineNodes(node.children) + '</strong>';
        break;
      case 'del':
        out += '<del>' + renderInlineNodes(node.children) + '</del>';
        break;
      case 'link': {
        out += '<a href="' + encodeHref(node.href) + '"';
        if (node.title !== null && node.title !== undefined) {
          out += ' title="' + escNoEncode(node.title) + '"';
        }
        out += '>' + renderInlineNodes(node.children) + '</a>';
        break;
      }
      case 'img': {
        out += '<img src="' + encodeHref(node.src) + '" alt="' + escNoEncode(node.alt) + '"';
        if (node.title !== null && node.title !== undefined) {
          out += ' title="' + escNoEncode(node.title) + '"';
        }
        out += '>';
        break;
      }
    }
  }
  return out;
}

function renderBlock(block, refs, srcEndsNL, tight) {
  switch (block.t) {
    case 'paragraph': {
      const html = renderInlineNodes(parseInline(block.text, refs));
      return tight ? html : '<p>' + html + '</p>\n';
    }
    case 'heading': {
      const text = block.lines.join('\n');
      return (
        '<h' +
        block.level +
        '>' +
        renderInlineNodes(parseInline(text, refs)) +
        '</h' +
        block.level +
        '>\n'
      );
    }
    case 'code': {
      const content =
        block.lines.length > 0 ? block.lines.join('\n') + '\n' : '';
      let cls = '';
      if (block.fenced && block.info) {
        const word = block.info.split(/[ \t]/)[0];
        if (word) {
          // Backslash escapes in the info string are resolved.
          const unescaped = word.replace(
            /\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g,
            '$1',
          );
          cls = ' class="language-' + escNoEncode(unescaped) + '"';
        }
      }
      return '<pre><code' + cls + '>' + escPlain(content) + '</code></pre>\n';
    }
    case 'thematic_break':
      return '<hr>\n';
    case 'blockquote':
      return (
        '<blockquote>\n' +
        renderBlocks(block.children, refs, srcEndsNL, false) +
        '</blockquote>\n'
      );
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      let out = '<' + tag;
      if (block.ordered && block.start !== 1) {
        out += ' start="' + block.start + '"';
      }
      out += '>\n';
      for (const item of block.children) {
        out += renderBlock(item, refs, srcEndsNL, block.tight);
      }
      out += '</' + tag + '>\n';
      return out;
    }
    case 'item': {
      let out = '<li>';
      let firstPara = null;
      if (block.children.length > 0 && block.children[0].t === 'paragraph') {
        firstPara = block.children[0];
      }
      let strippedFirst = null;
      if (firstPara) {
        const m = /^\[( |x|X)\][ \t]/.exec(firstPara.text);
        if (m) {
          // The checkbox is part of the paragraph text (not a prefix
          // before it), so in a loose list it renders inside the
          // `<p>`: `<li><p><input ...> foo</p></li>`.
          const checkbox =
            m[1] === ' '
              ? '<input disabled="" type="checkbox">'
              : '<input checked="" disabled="" type="checkbox">';
          strippedFirst = {
            t: 'paragraph',
            text: checkbox + firstPara.text.slice(3),
          };
        }
      }
      for (let ci = 0; ci < block.children.length; ci++) {
        let child = block.children[ci];
        if (ci === 0 && strippedFirst) child = strippedFirst;
        out += renderBlock(child, refs, srcEndsNL, tight);
      }
      out += '</li>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < block.headerCells.length; i++) {
        const align = block.aligns[i];
        out +=
          '<th' +
          (align ? ' align="' + align + '"' : '') +
          '>' +
          renderInlineNodes(parseInline(block.headerCells[i], refs)) +
          '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (block.rows.length > 0) {
        out += '<tbody>';
        for (const row of block.rows) {
          out += '<tr>\n';
          for (let i = 0; i < block.headerCells.length; i++) {
            const align = block.aligns[i];
            const cell = i < row.length ? row[i] : '';
            out +=
              '<td' +
              (align ? ' align="' + align + '"' : '') +
              '>' +
              renderInlineNodes(parseInline(cell, refs)) +
              '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
    case 'html': {
      const text = block.lines.join('\n');
      let out = text;
      if (block.kind <= 5 && block.endedAtMarker) {
        // Types 1-5 ending at a marker line: the newline after the
        // marker line is part of the output, unless the next line is
        // blank, or the marker is on the last line and the source has
        // no trailing newline.
        if (!block.followedByBlank && (!block.endsAtEOF || srcEndsNL)) {
          out += '\n';
        }
      } else if (block.endsAtEOF && srcEndsNL) {
        out += '\n';
      }
      return out;
    }
    default:
      return '';
  }
}

function renderBlocks(blocks, refs, srcEndsNL, tight) {
  let out = '';
  for (const block of blocks) {
    out += renderBlock(block, refs, srcEndsNL, tight);
  }
  return out;
}

export function parse(markdown) {
  inAnchor = false;
  const src = markdown.replace(/\r\n?/g, '\n');
  const { doc, refs, srcEndsNL } = blockParse(src);
  let out = '';
  for (const block of doc.children) {
    out += renderBlock(block, refs, srcEndsNL, false);
  }
  return out;
}
