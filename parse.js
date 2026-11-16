// parse.js — a fast, dependency-free Markdown parser whose parse(markdown)
// returns exactly the HTML that marked 18.1.3 renders with its default
// options (GFM on, breaks off). Written from scratch against the
// CommonMark 0.31.2 / GFM 0.29 rules as marked implements them, and tuned
// by diffing its output against marked on the practice set.
//
// Design: a line-based block parser (one pass over the lines, containers
// recurse on stripped line slices) plus a single-pass inline scanner that
// builds a small node list and resolves emphasis with the CommonMark
// delimiter-stack algorithm. No per-character objects on the hot paths,
// precompiled regexes, and output built with one join per block level.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Escape <, >, ", ' always; escape & only when it does not start a
// valid entity reference (a named &word; or a numeric &#123; / &#x1f;
// with the digit limits marked enforces). This is marked's no-encode
// escape, used for text, code, and attribute values alike.
const ESC_RE = /[<>"']|&(?!(\w+;|#\d{1,7};|#[xX][0-9a-fA-F]{1,6};))/g;
function escapeHtml(s) {
  return s.replace(ESC_RE, (c) => ESC[c]);
}
function escapeAttr(s) {
  return s.replace(ESC_RE, (c) => ESC[c]);
}
// Full escape for code content (code spans, indented and fenced code):
// every & is escaped, even one that looks like an entity reference.
const ESC_CODE_RE = /[&<>"']/g;
function escapeCode(s) {
  return s.replace(ESC_CODE_RE, (c) => ESC[c]);
}

// Decode one numeric entity starting at s[i] === '&'. Returns
// [decoded, length] or null. Named entities are NOT decoded by marked:
// they pass through as text and the escape step leaves &name; alone.
// Numeric: &# + 1-7 decimal digits, or &#x / &#X + 1-6 hex digits, then
// ';'. A value of 0, above U+10FFFF, or a surrogate becomes U+FFFD.
function decodeEntity(s, i) {
  if (s.charCodeAt(i + 1) !== 35) return null; // not '&#'
  let j = i + 2;
  let hex = false;
  if (j < s.length && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
  const start = j;
  if (hex) {
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) break;
      j++;
    }
    if (j - start < 1 || j - start > 6) return null;
  } else {
    while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    if (j - start < 1 || j - start > 7) return null;
  }
  if (j >= s.length || s.charCodeAt(j) !== 59) return null; // no ';'
  const cp = parseInt(s.slice(start, j), hex ? 16 : 10);
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return ['\ufffd', j - i + 1];
  return [String.fromCodePoint(cp), j - i + 1];
}

// Character classes for emphasis flanking (CommonMark definitions).
const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
function isAsciiPunct(c) { return ASCII_PUNCT.indexOf(c) >= 0; }
const UNICODE_PUNCT_RE = /^[\p{P}\p{S}]$/u;
function isPunct(c) {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  if (code < 128) return isAsciiPunct(c);
  return UNICODE_PUNCT_RE.test(c);
}
const UNICODE_WS_RE = /^[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]$/;
function isWS(c) {
  if (c === undefined) return true;
  const code = c.charCodeAt(0);
  if (code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12) return true;
  if (code < 128) return false;
  return UNICODE_WS_RE.test(c);
}
function isSpaceOrTab(c) { return c === ' ' || c === '\t'; }

// --- line / indent helpers -------------------------------------------------
// A line is a plain string (no trailing \n). Tabs expand to the next
// multiple of 4 columns. Returns [columns of leading indent, index of
// first non-space/tab char].
function indentOf(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col & 3); i++; }
    else break;
  }
  return [col, i];
}
// Is the line blank (only spaces/tabs)?
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// Remove `n` columns of leading indent from a line, expanding a tab that
// straddles the cut into the spaces that remain of it. The rest of the
// line is returned untouched (tabs inside the text are kept).
function stripIndent(line, n) {
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col & 3);
      if (col + w <= n) { col += w; i++; }
      else {
        // tab straddles the cut: it becomes spaces for the remainder
        return ' '.repeat(col + w - n) + line.slice(i + 1);
      }
    } else break;
  }
  return line.slice(i);
}
// Expand the leading whitespace run of line[i..] into spaces, counting
// columns from `col`. Only the leading run is touched; tabs later in the
// line are kept as-is.
function expandFrom(line, i, col) {
  let j = i, c2 = col;
  while (j < line.length) {
    const ch = line.charCodeAt(j);
    if (ch === 32) { c2++; j++; }
    else if (ch === 9) { c2 += 4 - (c2 & 3); j++; }
    else break;
  }
  if (j === i) return line.slice(i);
  return ' '.repeat(c2 - col) + line.slice(j);
}
// Remove `n` columns from the start of a line (a tab straddling the cut
// becomes the spaces that remain of it), then expand any leading
// whitespace left behind into spaces, column-aware. This is how a
// container prefix (blockquote `> `, list item indent) is stripped: the
// columns after the prefix keep their original widths, so a tab just
// after the prefix turns into the right number of spaces. Code content
// is NOT stripped this way (its tabs stay raw).
function stripColumns(line, n) {
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col & 3);
      if (col + w <= n) { col += w; i++; }
      else return ' '.repeat(col + w - n) + expandFrom(line, i + 1, col + w);
    } else { col++; i++; } // any other char (e.g. a `>` or `-` marker) is 1 column
  }
  return expandFrom(line, i, col);
}

// --- inline parsing --------------------------------------------------------
// Node kinds (small arrays):
//   ['t', text]            plain text (entities decoded, not yet escaped)
//   ['d', ch, len, canOpen, canClose]  emphasis / strikethrough delimiter run
//   ['c', text]            code span (content processed)
//   ['e', tag, children]   em / strong / del container
//   ['l', href, title, children]  link
//   ['i', src, title, alt] image
//   ['h', raw]             raw inline HTML
//   ['b']                  hard line break
//   ['a', href, text]      autolink

const SCHEME_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+.-';
function isSchemeChar(c) { return SCHEME_CHARS.indexOf(c) >= 0; }
const EMAIL_LOCAL = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-";
function isEmailLocalChar(c) { return EMAIL_LOCAL.indexOf(c) >= 0; }
function isAlnum(c) {
  const code = c.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
// A URL character for GFM autolinks: anything but whitespace or <.
function isUrlChar(c) {
  return c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && c !== '<';
}

// Find candidate autolink start positions in a raw inline string, sorted.
// Scheme: maximal run of scheme chars (2..32, letter first) followed by
// "://". www: "www." preceded by start, whitespace, '(', '*', '_' or '~'.
// Email: local part + @ + dotted domain.
function autolinkCandidates(s) {
  const out = [];
  let p = 0;
  while ((p = s.indexOf('://', p)) >= 0) {
    let i = p - 1;
    while (i >= 0 && isSchemeChar(s[i])) i--;
    i++;
    const len = p - i;
    if (len >= 2 && len <= 32 && s.charCodeAt(i) >= 65 && s.charCodeAt(i) <= 90 || len >= 2 && len <= 32 && s.charCodeAt(i) >= 97 && s.charCodeAt(i) <= 122) {
      out.push(i);
    }
    p += 3;
  }
  p = 0;
  while ((p = s.indexOf('www.', p)) >= 0) {
    const prev = p === 0 ? undefined : s[p - 1];
    if (prev === undefined || isWS(prev) || prev === '(' || prev === '*' || prev === '_' || prev === '~') {
      out.push(p);
    }
    p += 4;
  }
  p = 0;
  while ((p = s.indexOf('@', p)) >= 0) {
    let i = p - 1;
    while (i >= 0 && isEmailLocalChar(s[i])) i--;
    i++;
    if (i < p && matchEmailDomain(s, p + 1) > 0) {
      // A mailto: / xmpp: scheme before the email is part of the
      // autolink (other schemes are not: only the email links).
      if (i >= 7 && s.slice(i - 7, i) === 'mailto:') out.push(i - 7);
      else if (i >= 5 && s.slice(i - 5, i) === 'xmpp:') out.push(i - 5);
      else out.push(i);
    }
    p++;
  }
  out.sort((a, b) => a - b);
  return out;
}
// Match a dotted domain starting at s[i] (after the @). Returns the end
// index (exclusive) or 0. Domain labels: alnum, then up to 61 alnum/-,
// then alnum; at least one dot required. A dot starts another label
// only when an alnum follows it (otherwise it is trailing punctuation
// and the domain ends before it). A trailing - or _ after the domain
// invalidates the email entirely.
function matchEmailDomain(s, i) {
  let j = i;
  let dots = 0;
  while (true) {
    if (j >= s.length || !isAlnum(s[j])) return 0;
    let k = j + 1;
    while (k < s.length && (isAlnum(s[k]) || s[k] === '-')) k++;
    // label is s[j..k); it must not end with '-'
    if (s[k - 1] === '-') k--;
    if (k === j) return 0;
    j = k;
    if (j < s.length && s[j] === '.') {
      if (j + 1 < s.length && isAlnum(s[j + 1])) { dots++; j++; continue; }
      break;
    }
    break;
  }
  if (dots === 0) return 0;
  if (j < s.length && (s[j] === '-' || s[j] === '_')) return 0;
  return j;
}

// Trim a GFM autolink's trailing punctuation per the spec: trailing
// ? ! . , : * _ ~ are dropped; a trailing ; is dropped unless it ends an
// entity; an unbalanced trailing ) is dropped; and when the parens are
// unbalanced the URL is cut at the last unmatched (, then punctuation is
// trimmed again.
function trimAutolink(url) {
  let end = url.length;
  for (;;) {
    let changed = false;
    while (end > 0) {
      const c = url[end - 1];
      if (c === '?' || c === '!' || c === '.' || c === ',' || c === ':' || c === '*' || c === '_' || c === '~') { end--; changed = true; continue; }
      if (c === ';') {
        const amp = url.lastIndexOf('&', end - 2);
        if (amp >= 0) {
          const between = url.slice(amp + 1, end - 1);
          if (/^#[0-9]+$/.test(between) || /^#[xX][0-9a-fA-F]+$/.test(between)) {
            // numeric entity: only the ; is dropped
            end--; changed = true; continue;
          }
          if (/^[a-zA-Z0-9]+$/.test(between)) {
            // named entity-like: the whole &...; is not part of the URL
            end = amp; changed = true; continue;
          }
        }
        end--; changed = true; continue;
      }
      if (c === ')') {
        let open = 0, close = 0;
        for (let k = 0; k < end; k++) {
          if (url[k] === '(') open++;
          else if (url[k] === ')') close++;
        }
        if (close > open) { end--; changed = true; continue; }
      }
      break;
    }
    let open = 0, close = 0;
    for (let k = 0; k < end; k++) {
      if (url[k] === '(') open++;
      else if (url[k] === ')') close++;
    }
    if (open > close) {
      const idx = url.lastIndexOf('(', end - 1);
      if (idx < 0) break;
      end = idx;
      changed = true;
    }
    if (!changed) break;
  }
  return url.slice(0, end);
}

// Try to match a GFM autolink at s[i]. Returns [end, href, text] or null.
function matchAutolink(s, i, inLink) {
  if (inLink) return null;
  // scheme://
  const schemeEnd = s.indexOf('://', i);
  if (schemeEnd > 0 && schemeEnd - i >= 2 && schemeEnd - i <= 32) {
    let ok = true;
    const c0 = s.charCodeAt(i);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) ok = false;
    for (let k = i + 1; ok && k < schemeEnd; k++) if (!isSchemeChar(s[k])) ok = false;
    if (ok) {
      let j = schemeEnd + 3;
      while (j < s.length && isUrlChar(s[j])) j++;
      const url = trimAutolink(s.slice(i, j));
      if (url.length > 0) return [i + url.length, url, url];
    }
  }
  // www.
  if (s.startsWith('www.', i)) {
    let j = i + 4;
    while (j < s.length && isUrlChar(s[j])) j++;
    const url = trimAutolink(s.slice(i, j));
    if (url.length > 4) return [i + url.length, 'http://' + url, url];
  }
  // mailto: / xmpp: followed by an email, optionally followed by one
  // /segment (only these two schemes take an email; any other scheme
  // before an email links just the email).
  for (const sc of ['mailto:', 'xmpp:']) {
    if (s.startsWith(sc, i)) {
      let j = i + sc.length;
      if (j < s.length && isEmailLocalChar(s[j])) {
        while (j < s.length && isEmailLocalChar(s[j])) j++;
        if (j < s.length && s[j] === '@') {
          const dEnd = matchEmailDomain(s, j + 1);
          if (dEnd > 0) {
            let end = dEnd;
            if (end < s.length && s[end] === '/') {
              let p = end + 1;
              while (p < s.length && isUrlChar(s[p]) && s[p] !== '/') p++;
              if (p > end + 1) end = p;
            }
            const url = trimAutolink(s.slice(i, end));
            if (url.length > 0) return [i + url.length, url, url];
          }
        }
      }
      break;
    }
  }
  // email
  if (isEmailLocalChar(s[i])) {
    let j = i;
    while (j < s.length && isEmailLocalChar(s[j])) j++;
    if (j < s.length && s[j] === '@') {
      const dEnd = matchEmailDomain(s, j + 1);
      if (dEnd > 0) {
        const em = s.slice(i, dEnd);
        return [dEnd, 'mailto:' + em, em];
      }
    }
  }
  return null;
}

// Match a raw inline HTML tag at s[i] === '<'. Returns the end index
// (exclusive) or -1.
function matchHtmlTag(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return -1;
  const c = s[j];
  if (c === '!') {
    if (s.startsWith('<!--', i)) {
      // <!--> and <!---> are complete (abruptly closed) comments.
      if (s[i + 4] === '>') return i + 5;
      if (s[i + 4] === '-' && s[i + 5] === '>') return i + 6;
      const e = s.indexOf('-->', i + 4);
      if (e < 0) return -1;
      return e + 3;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      return e < 0 ? -1 : e + 3;
    }
    if (j + 1 < n && /[A-Za-z]/.test(s[j + 1])) {
      const e = s.indexOf('>', i + 2);
      return e < 0 ? -1 : e + 1;
    }
    return -1;
  }
  if (c === '?') {
    const e = s.indexOf('?>', i + 2);
    return e < 0 ? -1 : e + 2;
  }
  if (c === '/') {
    j++;
    if (j >= n || !/[A-Za-z]/.test(s[j])) return -1;
    while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
    while (j < n && isSpaceOrTab(s[j])) j++;
    if (j < n && s[j] === '>') return j + 1;
    return -1;
  }
  if (!/[A-Za-z]/.test(c)) return -1;
  while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
  // attributes (each must be preceded by whitespace)
  while (true) {
    let k = j;
    let hadWS = false;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) { k++; hadWS = true; }
    if (k >= n) return -1;
    if (s[k] === '>') return k + 1;
    if (s[k] === '/' && k + 1 < n && s[k + 1] === '>') return k + 2;
    if (s[k] === '/') return -1;
    if (!hadWS) return -1;
    // attribute name
    if (!/[A-Za-z_:]/.test(s[k])) return -1;
    while (k < n && /[A-Za-z0-9_.:-]/.test(s[k])) k++;
    // optional =value (whitespace allowed around =). The whitespace
    // before = is only consumed when an = actually follows, so the
    // separator before the next attribute is not eaten here.
    let k2 = k;
    while (k2 < n && (s[k2] === ' ' || s[k2] === '\t' || s[k2] === '\n' || s[k2] === '\r')) k2++;
    if (k2 < n && s[k2] === '=') {
      k = k2 + 1;
      while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
      if (k >= n) return -1;
      if (s[k] === '"' || s[k] === "'") {
        const q = s[k];
        const e = s.indexOf(q, k + 1);
        if (e < 0) return -1;
        k = e + 1;
      } else {
        const start = k;
        while (k < n && s[k] !== ' ' && s[k] !== '\t' && s[k] !== '\n' && s[k] !== '\r' && s[k] !== '"' && s[k] !== "'" && s[k] !== '=' && s[k] !== '<' && s[k] !== '>' && s[k] !== '`') k++;
        if (k === start) return -1;
      }
    }
    j = k;
  }
}

// Match an angle-bracket autolink / email at s[i] === '<'.
// Returns [end, href, text] or null.
function matchAngleAutolink(s, i) {
  const n = s.length;
  const gt = s.indexOf('>', i + 1);
  if (gt < 0) return null;
  const inner = s.slice(i + 1, gt);
  if (inner.length === 0) return null;
  if (/[\s<>]/.test(inner)) return null;
  // scheme:...
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.exec(inner);
  if (m) return [gt + 1, inner, inner];
  // email
  if (/^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(inner)) {
    return [gt + 1, 'mailto:' + inner, inner];
  }
  return null;
}

// --- link label / destination parsing --------------------------------------
// Find the index of the `]` matching the `[` at s[i], counting nested
// brackets and skipping code spans and backslash escapes. -1 if none.
// Find the closing ] of a reference label starting at s[i] === '['.
// Unlike findLabelEnd (for inline link text, which may contain nested
// brackets), a reference label ends at the first ]: it cannot contain
// a nested bracket. Code spans and <...> constructs are still skipped.
function findLabelEndFlat(s, i) {
  let j = i + 1;
  const n = s.length;
  while (j < n) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '<') {
      const a = matchAngleAutolink(s, j);
      if (a) { j = a[0]; continue; }
      const h = matchHtmlTag(s, j);
      if (h > 0) { j = h; continue; }
    }
    if (c === '`') {
      let k = j;
      while (k < n && s[k] === '`') k++;
      const run = k - j;
      let m = k;
      let found = -1;
      while (m < n) {
        if (s[m] === '`') {
          let e = m;
          while (e < n && s[e] === '`') e++;
          if (e - m === run) { found = e; break; }
          m = e;
        } else m++;
      }
      if (found < 0) { j = k; continue; }
      j = found;
      continue;
    }
    if (c === ']') return j;
    j++;
  }
  return -1;
}

function findLabelEnd(s, i) {
  let depth = 0;
  let j = i;
  const n = s.length;
  while (j < n) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '<') {
      // An angle autolink or HTML tag can contain a `]` (inside an
      // attribute value, or after the scheme); it eats the `]` that
      // would otherwise end the label, so skip past it.
      const a = matchAngleAutolink(s, j);
      if (a) { j = a[0]; continue; }
      const h = matchHtmlTag(s, j);
      if (h > 0) { j = h; continue; }
    }
    if (c === '`') {
      let k = j;
      while (k < n && s[k] === '`') k++;
      const run = k - j;
      // find the next run of exactly `run` backticks
      let m = k;
      let found = -1;
      while (m < n) {
        if (s[m] === '`') {
          let e = m;
          while (e < n && s[e] === '`') e++;
          if (e - m === run) { found = e; break; }
          m = e;
        } else m++;
      }
      if (found < 0) { j = k; continue; }
      j = found;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return -1;
}

// Does a label contain an unescaped [ (a [ not preceded by a
// backslash escape)? An escaped \[ is fine; a [ inside a code span
// still counts (the label is rejected).
function hasUnescapedBracket(label) {
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\' && i + 1 < label.length && isAsciiPunct(label[i + 1])) { i++; continue; }
    if (label[i] === '[') return true;
  }
  return false;
}

// Normalize a link reference label: trim, collapse internal whitespace
// (including newlines) to single spaces, Unicode case-fold. Case
// folding is not toLowerCase: ß and ẞ fold to "ss", and the ligatures
// fold to their expansions.
function caseFold(s) {
  return s.toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
}
function normalizeLabel(s) {
  return caseFold(s.trim().replace(/\s+/g, ' '));
}

// Process backslash escapes in a link destination / title: `\` + ASCII
// punctuation becomes the punctuation itself; other `\` stay.
function unescapeLink(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// Parse a link destination + optional title starting at s[i] === '('.
// Returns [href, title|null, endIndex] (endIndex is just past the ')'),
// or null when the parenthesised part is not a valid link.
function parseInlineLink(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j++;
  if (j >= n) return null;
  let href = '';
  if (s[j] === '<') {
    // angle-bracket destination: no < or newline inside; a backslash
    // escape (\>) is part of the destination, not the closing bracket.
    let k = j + 1;
    while (k < n) {
      const c = s[k];
      if (c === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) { k += 2; continue; }
      if (c === '>' || c === '\n' || c === '<') break;
      k++;
    }
    if (k >= n || s[k] !== '>') return null;
    href = unescapeLink(s.slice(j + 1, k));
    j = k + 1;
  } else {
    // bare destination: no spaces or control chars, balanced parens.
    // An empty destination is allowed when the next char is ')' (or a
    // title follows it): [a]( ) and [a]() are links with an empty href.
    let k = j;
    let depth = 0;
    while (k < n) {
      const c = s[k];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c.charCodeAt(0) < 32) break;
      if (c === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) { k += 2; continue; }
      if (c === '(') { depth++; k++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; k++; continue;
      }
      k++;
    }
    if (depth !== 0) return null;
    href = unescapeLink(s.slice(j, k));
    j = k;
  }
  // optional title
  let title = null;
  let k = j;
  while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
  if (k < n && s[k] !== ')') {
    const q = s[k];
    if (q === '"' || q === "'") {
      let e = k + 1;
      while (e < n && s[e] !== q && s[e] !== '\n') {
        if (s[e] === '\\' && e + 1 < n && isAsciiPunct(s[e + 1])) e += 2;
        else e++;
      }
      if (e >= n || s[e] !== q) return null;
      title = unescapeLink(s.slice(k + 1, e));
      k = e + 1;
    } else if (q === '(') {
      let e = k + 1;
      let depth = 1;
      while (e < n && depth > 0 && s[e] !== '\n') {
        if (s[e] === '\\' && e + 1 < n && isAsciiPunct(s[e + 1])) { e += 2; continue; }
        if (s[e] === '(') depth++;
        else if (s[e] === ')') depth--;
        e++;
      }
      if (depth !== 0) return null;
      title = unescapeLink(s.slice(k + 1, e - 1));
      k = e;
    } else {
      return null;
    }
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
  }
  if (k >= n || s[k] !== ')') return null;
  return [href, title, k + 1];
}

// Try to form a link or image starting at s[i] (s[i] === '['; for images
// the caller passes the '[' after '!'). Returns a node or null. `isImage`
// distinguishes the two. The link text is parsed inline (recursively) and
// the "no link inside a link" rule is enforced for links.
function tryLink(s, i, refs, isImage) {
  const labelEnd = findLabelEnd(s, i);
  if (labelEnd < 0) return null;
  const textRaw = s.slice(i + 1, labelEnd);
  const after = labelEnd + 1;
  let href = null, title = null, end = -1;
  if (after < s.length && s[after] === '(') {
    // inline link; () with nothing between is valid: [a]()
    if (after + 1 < s.length && s[after + 1] === ')') {
      href = ''; end = after + 2;
    } else {
      const r = parseInlineLink(s, after);
      if (r) {
        href = r[0]; title = r[1]; end = r[2];
      } else {
        // Not a valid inline link: fall back to a shortcut reference
        // (the [text] part is a reference if a definition matches).
        const label = normalizeLabel(textRaw);
        if (label.length === 0 || hasUnescapedBracket(label)) return null;
        const ref = refs.get(label);
        if (!ref) return null;
        href = ref[0]; title = ref[1]; end = after;
      }
    }
  } else if (after < s.length && s[after] === '[') {
    // full reference link [text][label], or collapsed [text][] (an
    // empty second label means the label is the link text). A
    // reference label ends at the first ] and cannot contain a nested
    // bracket.
    const refEnd = findLabelEndFlat(s, after);
    if (refEnd < 0) return null;
    let label = normalizeLabel(s.slice(after + 1, refEnd));
    if (label.length === 0) label = normalizeLabel(textRaw);
    if (label.length === 0 || hasUnescapedBracket(label)) return null;
    const ref = refs.get(label);
    if (!ref) return null;
    href = ref[0]; title = ref[1]; end = refEnd + 1;
  } else {
    // collapsed [text][] or shortcut [text]
    let label;
    if (after + 1 < s.length && s[after] === '[' && s[after + 1] === ']') {
      label = normalizeLabel(textRaw);
      end = after + 2;
    } else {
      label = normalizeLabel(textRaw);
      end = after;
    }
    if (label.length === 0 || hasUnescapedBracket(label)) return null;
    const ref = refs.get(label);
    if (!ref) return null;
    href = ref[0]; title = ref[1];
  }
  // Parse the link text inline (its own emphasis container).
  const children = parseInline(textRaw, refs, true);
  if (!isImage && hasLink(children)) return null; // no link in a link
  if (isImage) {
    return [['i', href, title, plainText(children)], end];
  }
  return [['l', href, title, children], end];
}

// Does a node list contain a link (recursively, through emphasis
// nodes)? An autolink is not a link for this rule: it may appear
// inside link text.
function hasLink(nodes) {
  for (const nd of nodes) {
    if (nd[0] === 'l') return true;
    if (nd[0] === 'e' && hasLink(nd[2])) return true;
  }
  return false;
}

// encodeURI, but a % is left alone (marked does not percent-encode
// it, even when it is not part of a valid %XX escape).
function encodeHref(href) {
  let out = '';
  let start = 0;
  for (let i = 0; i < href.length; i++) {
    if (href[i] === '%') {
      out += encodeURI(href.slice(start, i)) + '%';
      start = i + 1;
    }
  }
  out += encodeURI(href.slice(start));
  return out;
}

// Plain-text rendering of inline nodes (for image alt text).
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd[0] === 't') out += nd[1];
    else if (nd[0] === 'c') out += nd[1];
    else if (nd[0] === 'e') out += plainText(nd[2]);
    else if (nd[0] === 'l') out += plainText(nd[3]);
    else if (nd[0] === 'i') out += nd[3];
    else if (nd[0] === 'd') out += nd[1].repeat(nd[2]);
    else if (nd[0] === 'a') out += nd[2];
  }
  return out;
}

// Resolve emphasis / strikethrough in a node list with the CommonMark
// delimiter-stack algorithm (flanking rules + the odd-match rule of 3).
function resolveEmphasis(items) {
  const stack = []; // indices of delimiter nodes that can open
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it[0] !== 'd') { i++; continue; }
    if (it[4]) { // can close: look for the nearest matching opener
      let sj = stack.length - 1;
      let openerIdx = -1;
      while (sj >= 0) {
        const oi = stack[sj];
        const op = items[oi];
        if (!op || op[0] !== 'd' || op[1] !== it[1] || !op[3]) { sj--; continue; }
        // Rule of 3: if either delimiter can both open and close,
        // the sum of the lengths must not be a multiple of 3 unless
        // both lengths are multiples of 3.
        const eitherBoth = (op[3] && op[4]) || (it[3] && it[4]);
        if (eitherBoth && (op[2] + it[2]) % 3 === 0 && !(op[2] % 3 === 0 && it[2] % 3 === 0)) { sj--; continue; }
        // Blocking: a closer cannot match an opener across an em /
        // strong / del node whose closer could both open and close
        // while its opener could not (e.g. *a **b**c* has no outer em,
        // while *a **b** c* does and *foo**bar**baz* does; **a *b*c**
        // has no strong, while **a *b* c** does) -- unless another
        // delimiter sits between that node and the closer. A leftover
        // closer may still match across the container its own run just
        // created (e.g. *a **b***), so containers created by this same
        // delimiter node do not block.
        let blocked = false;
        for (let k = i - 1; k > oi; k--) {
          const nd = items[k];
          if (nd[0] !== 'e' || !nd[3] || nd[5] || nd[4] === it) continue;
          let shielded = false;
          for (let j = k + 1; j < i; j++) {
            if (items[j][0] === 'd') { shielded = true; break; }
          }
          if (!shielded) { blocked = true; break; }
          break; // a delimiter shields this and every earlier node too
        }
        if (blocked) { sj--; continue; }
        openerIdx = oi;
        break;
      }
      if (openerIdx >= 0) {
        const op = items[openerIdx];
        const use = (op[2] >= 2 && it[2] >= 2) ? 2 : 1;
        const tag = it[1] === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        const children = items.slice(openerIdx + 1, i);
        // nd[3]: the closer could both open and close. nd[4]: the closer
        // delimiter node that created this container (its own leftovers
        // are exempt). nd[5]: the opener could both open and close.
        // A container blocks an outer match across it only when its
        // closer could both open/close and its opener could not.
        const container = ['e', tag, children, (it[3] && it[4]), it, (op[3] && op[4])];
        op[2] -= use;
        it[2] -= use;
        const before = op[2] > 0 ? [op] : [];
        const after = it[2] > 0 ? [it] : [];
        items.splice(openerIdx, i - openerIdx + 1, ...before, container, ...after);
        // Drop stack entries that pointed inside the wrapped range (those
        // delimiters are now inside the container and cannot match out).
        for (let s2 = stack.length - 1; s2 >= 0; s2--) {
          if (stack[s2] > openerIdx && stack[s2] < i) stack.splice(s2, 1);
          else if (stack[s2] === openerIdx && op[2] === 0) stack.splice(s2, 1);
        }
        // Revisit the closer (if it survived) at its new index so it can
        // match another opener with its remaining length.
        i = openerIdx + before.length + 1;
        continue;
      }
      if (it[3]) stack.push(i);
      i++;
    } else {
      if (it[3]) stack.push(i);
      i++;
    }
  }
  return items;
}

// The inline scanner: one pass over a paragraph / link-text / table-cell
// string, producing a node list, then resolving emphasis over it.
function parseInline(s, refs, inLink) {
  const n = s.length;
  const items = [];
  const cands = autolinkCandidates(s);
  let ci = 0;
  let buf = '';
  let i = 0;
  let textStart = 0;
  const flush = (end) => {
    if (end > textStart) buf += s.slice(textStart, end);
    if (buf.length > 0) { items.push(['t', buf]); buf = ''; }
  };
  while (i < n) {
    while (ci < cands.length && cands[ci] < i) ci++;
    if (ci < cands.length && cands[ci] === i) {
      const m = matchAutolink(s, i, inLink);
      if (m) {
        flush(i);
        items.push(['a', m[1], m[2]]);
        i = m[0];
        textStart = i;
        continue;
      }
      ci++;
    }
    const c = s[i];
    if (c === '\n') {
      // Hard break: 2+ spaces at the end of the line. (A backslash
      // before the newline is handled by the '\' branch above, so a '\'
      // in the text here is always an escaped literal, not a break.)
      flush(i);
      let hard = false;
      const last = items.length ? items[items.length - 1] : null;
      if (last && last[0] === 't') {
        const t = last[1];
        let sp = 0;
        for (let k = t.length - 1; k >= 0 && t[k] === ' '; k--) sp++;
        if (sp >= 2) { last[1] = t.slice(0, t.length - sp); hard = true; }
        // A single trailing space is kept: only two or more make a
        // hard break.
        if (last[1].length === 0) items.pop();
      }
      items.push(hard ? ['b'] : ['t', '\n']);
      i++;
      textStart = i;
      if (hard) {
        // After a hard break, the next line's leading whitespace is
        // stripped (a soft break keeps it).
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        textStart = i;
      }
      continue;
    }
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        flush(i);
        items.push(['b']);
        i += 2;
        textStart = i;
        // After a hard break, the next line's leading whitespace is
        // stripped.
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        textStart = i;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) {
        flush(i);
        // A backslash-escaped & is a literal & and must be fully
        // escaped (&amp;), unlike a literal &entity; in the source.
        // Pre-escaping it keeps the no-encode escape from leaving it
        // raw when the following text looks like an entity name.
        buf = nx === '&' ? '&amp;' : nx;
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '`') {
      let k = i;
      while (k < n && s[k] === '`') k++;
      const run = k - i;
      let m = k;
      let found = -1;
      while (m < n) {
        if (s[m] === '`') {
          let e = m;
          while (e < n && s[e] === '`') e++;
          if (e - m === run) { found = m; break; }
          m = e;
        } else m++;
      }
      if (found < 0) { i = k; continue; }
      flush(i);
      let content = s.slice(k, found).replace(/\r\n|\r|\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim().length > 0) {
        content = content.slice(1, -1);
      }
      items.push(['c', content]);
      i = found + run;
      textStart = i;
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const r = tryLink(s, i + 1, refs, true);
      if (r) {
        flush(i);
        items.push(r[0]);
        i = r[1];
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '[') {
      const r = tryLink(s, i, refs, false);
      if (r) {
        flush(i);
        items.push(r[0]);
        i = r[1];
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '<') {
      const a = matchAngleAutolink(s, i);
      if (a) {
        flush(i);
        items.push(['a', a[1], a[2]]);
        i = a[0];
        textStart = i;
        continue;
      }
      const h = matchHtmlTag(s, i);
      if (h > 0) {
        flush(i);
        items.push(['h', s.slice(i, h)]);
        i = h;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '&') {
      const e = decodeEntity(s, i);
      if (e) {
        flush(i);
        // A decoded & (&#38; / &#x26;) is a literal & and must be fully
        // escaped, for the same reason as a backslash-escaped &.
        buf = e[0] === '&' ? '&amp;' : e[0];
        i += e[1];
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let k = i;
      while (k < n && s[k] === c) k++;
      const run = k - i;
      // A ~ run of 3 or more is not a strikethrough delimiter.
      if (c === '~' && run >= 3) { i = k; continue; }
      const before = i === 0 ? undefined : s[i - 1];
      const after = k >= n ? undefined : s[k];
      const beforeWS = isWS(before);
      const beforePunct = isPunct(before);
      const afterWS = isWS(after);
      const afterPunct = isPunct(after);
      const leftFlanking = !afterWS && (!afterPunct || beforeWS || beforePunct);
      const rightFlanking = !beforeWS && (!beforePunct || afterWS || afterPunct);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      flush(i);
      items.push(['d', c, run, canOpen, canClose]);
      i = k;
      textStart = i;
      continue;
    }
    i++;
  }
  flush(n);
  return resolveEmphasis(items);
}

// Render a node list to HTML.
function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    const k = nd[0];
    if (k === 't') out += escapeHtml(nd[1]);
    else if (k === 'd') out += escapeHtml(nd[1].repeat(nd[2]));
    else if (k === 'c') out += '<code>' + escapeCode(nd[1]) + '</code>';
    else if (k === 'e') {
      const tag = nd[1];
      out += '<' + tag + '>' + renderInline(nd[2]) + '</' + tag + '>';
    } else if (k === 'l') {
      out += '<a href="' + escapeAttr(encodeHref(nd[1])) + '"';
      if (nd[2] !== null && nd[2] !== undefined) out += ' title="' + escapeAttr(nd[2]) + '"';
      out += '>' + renderInline(nd[3]) + '</a>';
    } else if (k === 'i') {
      out += '<img src="' + escapeAttr(encodeHref(nd[1])) + '" alt="' + escapeHtml(nd[3]) + '"';
      if (nd[2] !== null && nd[2] !== undefined) out += ' title="' + escapeAttr(nd[2]) + '"';
      out += '>';
    } else if (k === 'h') out += nd[1];
    else if (k === 'b') out += '<br>';
    else if (k === 'a') {
      out += '<a href="' + escapeAttr(encodeHref(nd[1])) + '">' + escapeHtml(nd[2]) + '</a>';
    }
  }
  return out;
}
// Parse inline markdown and render it to HTML in one call.
function inlineHtml(s, refs, inLink) {
  return renderInline(parseInline(s, refs, inLink || false));
}

// --- block parsing ---------------------------------------------------------
// Block-level HTML tags for HTML block type 6.
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// ATX heading: [level, text] or null. Indent must be <= 3.
function matchAtx(line) {
  const [ind, idx] = indentOf(line);
  if (ind > 3) return null;
  let j = idx;
  let hashes = 0;
  while (j < line.length && line[j] === '#') { hashes++; j++; }
  if (hashes === 0 || hashes > 6) return null;
  if (j < line.length && line[j] !== ' ' && line[j] !== '\t') return null;
  let text = line.slice(j).trim();
  // closing sequence: spaces + #'s at the end, or the whole content
  const m = /(?:[ \t]+|^)#+$/.exec(text);
  if (m) text = text.slice(0, m.index).trimEnd();
  return [hashes, text];
}
function matchHr(line) {
  const [ind, idx] = indentOf(line);
  if (ind > 3) return null;
  const c = line[idx];
  if (c !== '*' && c !== '-' && c !== '_') return false;
  let count = 0;
  for (let j = idx; j < line.length; j++) {
    const ch = line[j];
    if (ch === c) count++;
    else if (ch !== ' ' && ch !== '\t') return false;
  }
  return count >= 3;
}
// Setext underline: 1 for ===, 2 for ---, 0 otherwise. The run of =
// or - may only be followed by spaces/tabs; spaces inside the run
// (e.g. `= =` or `--- -`) are not a setext underline.
function isSetext(line) {
  const [ind, idx] = indentOf(line);
  if (ind > 3) return 0;
  const c = line[idx];
  if (c !== '=' && c !== '-') return 0;
  let j = idx;
  while (j < line.length && line[j] === c) j++;
  for (let k = j; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return 0;
  }
  return c === '=' ? 1 : 2;
}
// Fenced code opener: {ch, len, indent, info} or null.
function matchFence(line) {
  const [ind, idx] = indentOf(line);
  if (ind > 3) return null;
  const c = line[idx];
  if (c !== '`' && c !== '~') return null;
  let j = idx;
  while (j < line.length && line[j] === c) j++;
  const len = j - idx;
  if (len < 3) return null;
  let info = line.slice(j).trim();
  if (c === '`' && info.indexOf('`') >= 0) return null;
  return { ch: c, len, indent: ind, info };
}
function isFenceClose(line, fence) {
  const [ind, idx] = indentOf(line);
  if (ind > 3) return false;
  let j = idx;
  while (j < line.length && line[j] === fence.ch) j++;
  if (j - idx < fence.len) return false;
  for (let k = j; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}
// HTML block start: returns {type, endTag} or null. Types 1-7 per CommonMark.
function matchHtmlStart(line) {
  const [ind, idx] = indentOf(line);
  if (ind > 3) return null;
  if (line[idx] !== '<') return null;
  const rest = line.slice(idx + 1);
  const lower = rest.toLowerCase();
  for (const tag of ['script', 'pre', 'style', 'textarea']) {
    if (lower.startsWith(tag)) {
      const after = rest[tag.length];
      if (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/') {
        return { type: 1, endTag: tag };
      }
    }
  }
  if (rest.startsWith('!--')) return { type: 2 };
  if (rest.startsWith('?')) return { type: 3 };
  if (rest.startsWith('!') && rest.length > 1 && /[A-Za-z]/.test(rest[1])) return { type: 4 };
  if (rest.startsWith('![CDATA[')) return { type: 5 };
  const m = /^\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (m) {
    const tag = m[1].toLowerCase();
    if (BLOCK_TAGS.has(tag)) {
      const after = rest[m[0].length];
      if (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/') {
        return { type: 6 };
      }
    }
    // type 7: a complete open or closing tag alone on the line
    const tagEnd = matchHtmlTag(line.slice(idx), 0);
    if (tagEnd > 0 && /^[ \t]*$/.test(line.slice(idx + tagEnd))) return { type: 7 };
  }
  return null;
}
// Blockquote marker: returns the content after the marker, or null.
function stripBQMarker(line) {
  const [ind, idx] = indentOf(line);
  if (ind > 3) return null;
  if (line[idx] !== '>') return null;
  const next = line[idx + 1];
  const strip = idx + 1 + (next === ' ' || next === '\t' ? 1 : 0);
  return stripColumns(line, strip);
}
// A blockquote line: returns its stripped content, or null.
function matchBlockquote(line) {
  return stripBQMarker(line);
}
// List marker: returns info or null.
function matchListMarker(line) {
  const [ind, idx] = indentOf(line);
  if (ind > 3) return null;
  const c = line[idx];
  let markerLen = 0, ordered = false, startNum = 0, delim = '';
  if (c === '*' || c === '+' || c === '-') {
    markerLen = 1;
  } else if (c >= '0' && c <= '9') {
    let j = idx;
    while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
    if (j - idx > 9) return null;
    const d = line[j];
    if (d !== '.' && d !== ')') return null;
    ordered = true;
    startNum = parseInt(line.slice(idx, j), 10);
    delim = d;
    markerLen = j - idx + 1;
  } else return null;
  // whitespace after the marker
  let j = idx + markerLen;
  let sepCols = 0;
  let k = j;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    if (line[k] === ' ') { sepCols++; k++; }
    else {
      const col = idx + markerLen + sepCols;
      const w = 4 - (col & 3);
      sepCols += w;
      k++;
    }
  }
  const hasContent = k < line.length;
  if (!hasContent && sepCols === 0) {
    // marker at end of line: empty item
  } else if (sepCols === 0) {
    return null; // no space after the marker: not a list item
  }
  let contentIndent;
  if (!hasContent) contentIndent = ind + markerLen + 1;
  else if (sepCols >= 5) contentIndent = ind + markerLen + 1;
  else contentIndent = ind + markerLen + sepCols;
  return {
    indent: ind, ordered, startNum, delim, bullet: c,
    contentIndent, markerLen, hasContent,
  };
}

// --- link reference definitions --------------------------------------------
// Find the closing ] of a link label that starts at L[i][idx] === '[',
// scanning across lines (a label may span lines, but not a blank line).
// Returns [endLine, endPos, labelText] or null.
function findLabelEndMulti(L, i, end, idx) {
  let depth = 0;
  let cur = i;
  let p = idx;
  let label = '';
  while (cur < end) {
    const ln = L[cur];
    while (p < ln.length) {
      const c = ln[p];
      if (c === '\\' && p + 1 < ln.length && isAsciiPunct(ln[p + 1])) {
        if (depth > 0) label += ln.slice(p, p + 2);
        p += 2;
        continue;
      }
      if (c === '`') {
        let k = p;
        while (k < ln.length && ln[k] === '`') k++;
        const run = k - p;
        let m = k;
        let found = -1;
        while (m < ln.length) {
          if (ln[m] === '`') {
            let e = m;
            while (e < ln.length && ln[e] === '`') e++;
            if (e - m === run) { found = e; break; }
            m = e;
          } else m++;
        }
        if (found < 0) {
          if (depth > 0) label += ln.slice(p);
          p = ln.length;
          break;
        }
        if (depth > 0) label += ln.slice(p, found);
        p = found;
        continue;
      }
      if (c === '[') {
        // A definition label ends at the first ]: it cannot contain a
        // nested bracket, so the depth is not increased.
        if (depth > 0) label += c;
        else depth = 1;
      } else if (c === ']') {
        depth--;
        if (depth === 0) return [cur, p, label];
        label += c;
      } else if (depth > 0) {
        label += c;
      }
      p++;
    }
    cur++;
    if (cur >= end) return null;
    if (isBlank(L[cur])) return null;
    if (depth > 0) label += '\n';
    p = 0;
  }
  return null;
}

// Parse a link reference definition starting at L[i]. Returns the number
// of lines consumed, or 0 when the lines do not form a definition.
// A definition is: up to 3 spaces, [label]:, optional spaces, a
// destination (<...> or bare), then an optional title (on the same line
// or the next), then only whitespace to the line end. The label may
// span lines; the destination and the title may be on following lines
// (with any indent).
function tryParseDef(L, i, end, refs) {
  const line = L[i];
  const [ind, idx] = indentOf(line);
  if (ind > 3 || line[idx] !== '[') return 0;
  const le = findLabelEndMulti(L, i, end, idx);
  if (!le) return 0;
  const [leLine, lePos, labelRaw] = le;
  const label = normalizeLabel(labelRaw);
  // A label cannot contain a [ (even escaped or inside a code span).
  if (label.length === 0 || hasUnescapedBracket(label)) return 0;
  if (L[leLine][lePos + 1] !== ':') return 0;
  // destination: on the label's line, or on the next line
  let dLine = leLine;
  let j = lePos + 2;
  while (j < L[dLine].length && (L[dLine][j] === ' ' || L[dLine][j] === '\t')) j++;
  let href = '';
  let destLine = dLine;
  if (j >= L[dLine].length) {
    if (dLine + 1 >= end) return 0;
    const ln2 = L[dLine + 1];
    if (isBlank(ln2)) return 0;
    const [, idx2] = indentOf(ln2);
    const r = parseDestInLine(ln2, idx2);
    if (!r) return 0;
    href = r[0];
    destLine = dLine + 1;
    j = r[1];
  } else {
    const r = parseDestInLine(L[dLine], j);
    if (!r) return 0;
    href = r[0];
    j = r[1];
  }
  const t = parseTitleAt(L, destLine, j, end);
  if (t === false) return 0;
  if (t === 'next') {
    if (!refs.has(label)) refs.set(label, [href, null]);
    return destLine - i + 1;
  }
  if (t) {
    if (!refs.has(label)) refs.set(label, [href, t[0]]);
    return t[1] - i + 1;
  }
  if (!refs.has(label)) refs.set(label, [href, null]);
  return destLine - i + 1;
}
// Parse a link destination at line[pos..]. Returns [href, endIndex] or null.
function parseDestInLine(line, pos) {
  const n = line.length;
  if (pos >= n) return null;
  if (line[pos] === '<') {
    let k = pos + 1;
    while (k < n && line[k] !== '>' && line[k] !== '\n' && line[k] !== '<') k++;
    if (k >= n || line[k] !== '>') return null;
    return [unescapeLink(line.slice(pos + 1, k)), k + 1];
  }
  let k = pos;
  let depth = 0;
  while (k < n) {
    const c = line[k];
    if (c === ' ' || c === '\t' || c.charCodeAt(0) < 32) break;
    if (c === '\\' && k + 1 < n && isAsciiPunct(line[k + 1])) { k += 2; continue; }
    if (c === '(') { depth++; k++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; k++; continue;
    }
    k++;
  }
  if (depth !== 0) return null;
  if (k === pos) return null; // empty bare destination is not allowed here
  return [unescapeLink(line.slice(pos, k)), k];
}
// Parse an optional title at L[li][pos..] (after a destination), on the
// same line or the next. Returns:
//   [title, lineIndex]  a valid title (lineIndex is the line it ends on)
//   null                no title, and nothing but whitespace follows
//   false               invalid: junk after the destination/title on the
//                       SAME line (the definition is not a definition)
//   'next'              the title is on the NEXT line but is not a valid
//                       title: the definition is still valid without a
//                       title, and the next line is not consumed.
function parseTitleAt(L, li, pos, end) {
  const line = L[li];
  let j = pos;
  let skippedWS = false;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) { j++; skippedWS = true; }
  if (j >= line.length) {
    // title may be on the next line
    if (li + 1 >= end) return null;
    const ln2 = L[li + 1];
    if (isBlank(ln2)) return null;
    const [, idx2] = indentOf(ln2);
    const t = parseTitleFrom(L, li + 1, idx2, end);
    if (t === false || t === null) return 'next';
    return t;
  }
  // same line: a title needs whitespace before it (a title glued to the
  // destination, e.g. <bar>(baz), is junk, not a title)
  if (!skippedWS) return false;
  const t = parseTitleFrom(L, li, j, end);
  if (t === false) return false;
  if (t === null) return false; // junk after the destination
  return t;
}
// Parse a title starting at L[li][pos] ('"', "'" or '('). A title may
// span lines (the newlines are kept in the title text); it may not span
// a blank line. Returns [title, endLineIndex], null (not a title
// opener), or false (unterminated, or junk after the closing quote).
function parseTitleFrom(L, li, pos, end) {
  const q = L[li][pos];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let depth = 1;
  let raw = '';
  let cur = li;
  let e = pos + 1;
  while (cur < end) {
    const ln = L[cur];
    const segStart = e;
    let found = -1;
    while (e < ln.length) {
      const c = ln[e];
      if (c === '\\' && e + 1 < ln.length && isAsciiPunct(ln[e + 1])) { e += 2; continue; }
      if (q === '(') {
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) { found = e; break; } }
      } else if (c === close) { found = e; break; }
      e++;
    }
    if (found >= 0) {
      raw += ln.slice(segStart, found);
      let k = found + 1;
      while (k < ln.length && (ln[k] === ' ' || ln[k] === '\t')) k++;
      if (k < ln.length) return false;
      return [unescapeLink(raw), cur];
    }
    raw += ln.slice(segStart) + '\n';
    cur++;
    if (cur >= end) return false;
    if (isBlank(L[cur])) return false;
    e = 0;
  }
  return false;
}

// --- tables ----------------------------------------------------------------
// Split a table row on unescaped pipes; drop an empty first/last cell when
// the line starts/ends with a pipe. Cells are trimmed.
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  const trimmed = line.trim();
  if (cells.length > 0 && cells[0].trim() === '' && trimmed.startsWith('|')) cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '' && trimmed.endsWith('|')) cells.pop();
  return cells.map((c) => c.trim());
}
// Is this line a table delimiter row? Returns the alignments
// ('left' | 'right' | 'center' | null) per column, or null.
function parseDelimiterRow(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    if (m[1] && m[2]) aligns.push('center');
    else if (m[2]) aligns.push('right');
    else if (m[1]) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}
// Does line (a potential header) plus next form a table?
function isTableStart(header, next) {
  if (next === undefined || next === null) return false;
  if (indentOf(header)[0] > 3 || indentOf(next)[0] > 3) return false;
  if (header.indexOf('|') < 0) return false;
  const aligns = parseDelimiterRow(next);
  if (!aligns) return false;
  return splitTableRow(header).length === aligns.length;
}

// Is this line a table delimiter row (on its own, e.g. a setext-like
// check for lazy-continuation / interruption decisions)?
function isTableDelimiter(line) {
  if (indentOf(line)[0] > 3) return false;
  return parseDelimiterRow(line) !== null;
}

// --- lazy continuation -----------------------------------------------------
// Does the content (already container-stripped lines) end with an open
// paragraph? Used to decide whether a line without a container marker is
// a lazy continuation of the paragraph inside a blockquote / list item.
function isParaLine(s) {
  if (s.length === 0 || isBlank(s)) return false;
  if (matchAtx(s) || matchFence(s) || matchHr(s) || matchHtmlStart(s)) return false;
  if (isSetext(s) || isTableDelimiter(s)) return false;
  if (indentOf(s)[0] >= 4) return false;
  if (matchBlockquote(s) !== null || matchListMarker(s)) return false;
  return true;
}
function endsInOpenPara(lines) {
  let inFence = null;
  let inTable = false;
  let lastKind = 'none'; // 'para' | 'other' | 'blank' | 'none'
  for (let n = 0; n < lines.length; n++) {
    const ln = lines[n];
    if (inFence) {
      if (isFenceClose(ln, inFence)) { inFence = null; lastKind = 'other'; }
      continue;
    }
    if (isBlank(ln)) { lastKind = 'blank'; inTable = false; continue; }
    if (inTable) {
      // a table row (any non-blank line that does not start a block)
      if (matchAtx(ln) || matchFence(ln) || matchHr(ln) || matchHtmlStart(ln) || matchBlockquote(ln) !== null || matchListMarker(ln) || isSetext(ln)) {
        inTable = false;
      } else { lastKind = 'other'; continue; }
    }
    const f = matchFence(ln);
    if (f) { inFence = f; lastKind = 'other'; continue; }
    if (matchAtx(ln) || matchHr(ln) || matchHtmlStart(ln) || isSetext(ln)) { lastKind = 'other'; continue; }
    if (isTableDelimiter(ln)) { lastKind = 'other'; inTable = true; continue; }
    if (indentOf(ln)[0] >= 4) { lastKind = lastKind === 'para' ? 'para' : 'other'; continue; }
    const bq = matchBlockquote(ln);
    if (bq !== null) { lastKind = endsInOpenPara([bq]) ? 'para' : 'other'; continue; }
    const lm = matchListMarker(ln);
    if (lm) {
      const content = stripColumns(ln, lm.contentIndent);
      lastKind = endsInOpenPara([content]) ? 'para' : 'other';
      continue;
    }
    lastKind = 'para';
  }
  return lastKind === 'para';
}

// Collect a blockquote's content lines starting at L[i] (a `>` line).
// Returns [contentLines, nextIndex, hadTrailingBlanks, lazySetext]:
// hadTrailingBlanks is true when blank lines at the end of the quote's
// content were trimmed (the container's text ends with a newline then),
// and lazySetext holds the indices (into contentLines) of lines that
// were added as lazy continuations and look like a setext underline:
// a lazy line can never be a setext underline, so the inner parse must
// not treat those lines as one. A plain blank line ends the quote (only
// `>` lines keep it going); trailing `>` blank lines are still consumed.
function collectBlockquote(L, i, end) {
  const content = [];
  const srcIdx = [];
  // Indices of content lines that were added as lazy continuation
  // lines. The inner parse must treat them as paragraph text, never
  // as a block start (a lazy line, stripped of 4 columns, can look
  // like a list marker or a setext underline).
  const lazyLines = new Set();
  let lastLazy = false;
  let j = i;
  while (j < end) {
    const line = L[j];
    const bq = stripBQMarker(line);
    if (bq !== null) {
      content.push(bq);
      srcIdx.push(j);
      lastLazy = false;
      j++;
      continue;
    }
    if (!isBlank(line) && endsInOpenPara(content) && !startsBlock(line)) {
      // A lazy continuation line. Its leading indent is stripped by
      // 4 columns when it is 4 or more; a smaller indent is kept.
      // A lazy line that looks like a setext underline is paragraph
      // text, not an underline: when the previous content line was
      // also lazy and the indent is under 4, the indent is set to
      // exactly 4 columns instead (so it cannot be read as one).
      let add = line;
      const [ind, idx] = indentOf(line);
      if (isSetext(line) !== 0) {
        if (lastLazy && ind < 4) add = '    ' + line.slice(idx);
      } else if (ind >= 4) {
        add = stripIndent(line, 4);
      }
      lazyLines.add(content.length);
      content.push(add);
      srcIdx.push(j);
      lastLazy = true;
      j++;
      continue;
    }
    break;
  }
  // trailing blank lines do not belong to the quote (they are all `>`
  // lines here, since a plain blank line ends the quote)
  let k = content.length;
  while (k > 0 && content[k - 1] === '') k--;
  const hadTrailingBlanks = k < content.length;
  // Consume the trailing `>` blank lines too: they are part of the
  // quote even though their content is empty.
  const next = srcIdx.length ? srcIdx[srcIdx.length - 1] + 1 : i + 1;
  return [content.slice(0, k), next, hadTrailingBlanks, lazyLines];
}

// --- the block parser ------------------------------------------------------
// Parses lines L[start..end) and returns {html, loose}: loose is true when
// two block-level elements in this sequence are separated by a blank line.
function parseBlocks(L, start, end, ctx) {
  let out = '';
  let loose = false;
  let seenBlock = false;
  let pendingBlank = false;
  let i = start;
  while (i < end) {
    const line = L[i];
    if (isBlank(line)) { pendingBlank = true; i++; continue; }
    // link reference definitions (consume at block start only). A
    // definition is a block-level element: it counts for the
    // blank-line separation that makes a list loose, even though it
    // renders nothing.
    const defLines = tryParseDef(L, i, end, ctx.refs);
    if (defLines > 0) {
      if (pendingBlank && seenBlock) loose = true;
      pendingBlank = false; seenBlock = true;
      i += defLines; continue;
    }
    const atx = matchAtx(line);
    if (atx) {
      if (pendingBlank && seenBlock) loose = true;
      pendingBlank = false; seenBlock = true;
      out += '<h' + atx[0] + '>' + (ctx.collectOnly ? '' : inlineHtml(atx[1], ctx.refs)) + '</h' + atx[0] + '>\n';
      i++;
      continue;
    }
    const fence = matchFence(line);
    if (fence) {
      if (pendingBlank && seenBlock) loose = true;
      pendingBlank = false; seenBlock = true;
      const lang = unescapeLink(fence.info).split(/[ \t]/)[0];
      // The last content line, if blank, is dropped: the newline
      // before the closing fence is not part of the code.
      const codeLines = [];
      let j = i + 1;
      while (j < end) {
        if (isFenceClose(L[j], fence)) break;
        const cl = L[j];
        codeLines.push(fence.ch === '`' ? stripIndent(cl, fence.indent) : cl);
        j++;
      }
      if (codeLines.length > 0 && codeLines[codeLines.length - 1] === '') codeLines.pop();
      const code = codeLines.length > 0 ? codeLines.join('\n') + '\n' : '';
      if (j < end) j++; // skip the closing fence
      out += '<pre><code' + (lang ? ' class="language-' + escapeAttr(lang) + '"' : '') + '>' + escapeCode(code) + '</code></pre>\n';
      i = j;
      continue;
    }
    const htmlStart = matchHtmlStart(line);
    if (htmlStart) {
      if (pendingBlank && seenBlock) loose = true;
      pendingBlank = false; seenBlock = true;
      let j = i;
      let raw = '';
      const type = htmlStart.type;
      while (j < end) {
        const ln = L[j];
        if (j > i) {
          if (type === 6 || type === 7) {
            if (isBlank(ln)) break;
          } else if (type === 1) {
            // ends at a line containing the closing tag
          }
        }
        raw += ln + '\n';
        j++;
        if (type === 1 && ln.toLowerCase().indexOf('</' + htmlStart.endTag) >= 0) break;
        if (type === 2 && ln.indexOf('-->') >= 0) break;
        if (type === 3 && ln.indexOf('?>') >= 0) break;
        if (type === 4 && ln.indexOf('>') >= 0) break;
        if (type === 5 && ln.indexOf(']]>') >= 0) break;
      }
      // The final newline is dropped when the block is followed by a
      // blank line, and when the block runs to the end of a nested
      // container's content (that container's text has no newline
      // after its last line). At the top level it is kept when the
      // document ends with a newline; when the container's content
      // ended with blank lines that were trimmed, it is kept too (the
      // text after the block's last line is a blank line's newline).
      if (j < end && isBlank(L[j])) raw = raw.slice(0, -1);
      else if (j === end && ctx.topLevel && !ctx.docEndsWithNL) raw = raw.slice(0, -1);
      else if (j === end && !ctx.topLevel && !ctx.hadTrailingBlank) raw = raw.slice(0, -1);
      out += raw;
      i = j;
      continue;
    }
    if (matchHr(line)) {
      if (pendingBlank && seenBlock) loose = true;
      pendingBlank = false; seenBlock = true;
      out += '<hr>\n';
      i++;
      continue;
    }
    if (stripBQMarker(line) !== null) {
      if (pendingBlank && seenBlock) loose = true;
      pendingBlank = false; seenBlock = true;
      const [content, next, hadTrailingBlanks, lazyLines] = collectBlockquote(L, i, end);
      const childCtx = {
        refs: ctx.refs, docEndsWithNL: ctx.docEndsWithNL,
        lastIsDocEnd: ctx.lastIsDocEnd && next === end, inListItem: false,
        collectOnly: ctx.collectOnly, topLevel: false,
        hadTrailingBlank: hadTrailingBlanks, lazyLines, inBlockquote: true,
      };
      const inner = parseBlocks(content, 0, content.length, childCtx);
      out += '<blockquote>\n' + inner.html + '</blockquote>\n';
      i = next;
      continue;
    }
    const lm = matchListMarker(line);
    if (lm) {
      if (pendingBlank && seenBlock) loose = true;
      pendingBlank = false; seenBlock = true;
      const r = parseList(L, i, end, ctx);
      out += r.html;
      // A list consumes the trailing blank lines of its last item, so
      // the enclosing block never sees them; report them as a pending
      // blank so the next block still counts as separated by one.
      if (r.endsWithBlank) pendingBlank = true;
      i = r.next;
      continue;
    }
    const [ind] = indentOf(line);
    if (ind >= 4) {
      if (pendingBlank && seenBlock) loose = true;
      pendingBlank = false; seenBlock = true;
      let code = '';
      let j = i;
      while (j < end) {
        const ln = L[j];
        if (isBlank(ln)) {
          // blank lines are included only when a code line follows;
          // a blank line is stripped by 4 columns like any other
          // line (a 6-space blank line contributes 2 spaces).
          let k = j + 1;
          while (k < end && isBlank(L[k])) k++;
          if (k >= end) break;
          const [ind2] = indentOf(L[k]);
          if (ind2 < 4) break;
          while (j < k) { code += stripIndent(L[j], 4) + '\n'; j++; }
          continue;
        }
        const [ind2] = indentOf(ln);
        if (ind2 < 4) break;
        code += stripIndent(ln, 4) + '\n';
        j++;
      }
      out += '<pre><code>' + escapeCode(code) + '</code></pre>\n';
      i = j;
      continue;
    }
    // paragraph / table / setext heading
    const r = parseParagraph(L, i, end, ctx);
    if (pendingBlank && seenBlock) loose = true;
    pendingBlank = false; seenBlock = true;
    out += r.html;
    i = r.next;
  }
  return { html: out, loose };
}

// Does this line start a block that can interrupt a paragraph?
function interruptsPara(line) {
  if (isBlank(line)) return false;
  if (matchAtx(line) || matchFence(line) || matchHr(line)) return true;
  const h = matchHtmlStart(line);
  if (h && h.type !== 7) return true;
  if (matchBlockquote(line) !== null) return true;
  const lm = matchListMarker(line);
  if (lm) {
    if (!lm.hasContent) return false; // an empty item cannot interrupt
    if (lm.ordered && lm.startNum !== 1) return false;
    return true;
  }
  if (isSetext(line) || isTableDelimiter(line)) return true;
  return false;
}
// Does this line start any block (for lazy-continuation decisions)?
// A setext underline or a table delimiter row is NOT a block start
// here: those are paragraph-level constructs, so a lazy line that
// looks like one is still a lazy continuation of the open paragraph
// (it is handled by the paragraph / table logic when the container's
// content is parsed, not by ending the container).
function startsBlock(line) {
  if (isBlank(line)) return false;
  if (matchAtx(line) || matchFence(line) || matchHr(line)) return true;
  const h = matchHtmlStart(line);
  if (h && h.type !== 7) return true;
  if (matchBlockquote(line) !== null || matchListMarker(line)) return true;
  return false;
}

// Parse a paragraph (or a setext heading, or a table) starting at L[i].
function parseParagraph(L, i, end, ctx) {
  // a table whose header is the first line
  if (i + 1 < end && isTableStart(L[i], L[i + 1])) {
    const t = parseTable(L, i, end, ctx);
    return { html: t.html, next: t.next };
  }
  const lines = [L[i]];
  let j = i + 1;
  while (j < end) {
    const ln = L[j];
    if (isBlank(ln)) {
      // A trailing whitespace-only line inside a blockquote is part of
      // the paragraph (the quote's last line, not a separator); at the
      // top level, and in a list item, it is a blank line.
      if (ctx.inBlockquote && ln.length > 0 && j === end - 1) {
        lines.push(ln);
        j++;
      }
      break;
    }
    // A line that was added as a lazy continuation of a blockquote
    // or list item is paragraph text: it can never be a setext
    // underline, a table header, or a block start (after the 4-column
    // strip it can look like a list marker).
    if (ctx.lazyLines && ctx.lazyLines.has(j)) { lines.push(ln); j++; continue; }
    const st = isSetext(ln);
    if (st) {
      // A setext heading's content is the paragraph text with leading
      // and trailing spaces/tabs stripped (interior lines keep theirs).
      const raw = lines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      return {
        html: '<h' + st + '>' + (ctx.collectOnly ? '' : inlineHtml(raw, ctx.refs)) + '</h' + st + '>\n',
        next: j + 1,
      };
    }
    if (j + 1 < end && isTableStart(ln, L[j + 1])) {
      const t = parseTable(L, j, end, ctx);
      const para = ctx.noP
        ? (ctx.collectOnly ? '' : inlineHtml(lines.join('\n'), ctx.refs))
        : '<p>' + (ctx.collectOnly ? '' : inlineHtml(lines.join('\n'), ctx.refs)) + '</p>\n';
      return { html: para + t.html, next: t.next };
    }
    // A table delimiter line only interrupts the paragraph when it
    // forms a valid table with the paragraph's last line (the header);
    // otherwise it is a continuation line. When it does form a table,
    // the header is popped out of the paragraph and the table parsed.
    if (isTableDelimiter(ln)) {
      if (lines.length > 0 && isTableStart(lines[lines.length - 1], ln)) {
        const header = lines.pop();
        const tableLines = [header, ln].concat(L.slice(j + 1, end));
        const t = parseTable(tableLines, 0, tableLines.length, ctx);
        const paraHtml = lines.length > 0
          ? (ctx.collectOnly ? '' : (ctx.noP ? inlineHtml(lines.join('\n'), ctx.refs) : '<p>' + inlineHtml(lines.join('\n'), ctx.refs) + '</p>\n'))
          : '';
        // tableLines[0] is the header (L[j-1]) and tableLines[1] is the
        // delimiter (L[j]); the table's next index maps back to L.
        return { html: paraHtml + t.html, next: j - 1 + t.next };
      }
      // Not a valid table: fall through and treat it as a continuation.
    } else if (interruptsPara(ln)) {
      break;
    }
    let cont = ln;
    if (ctx.inListItem) {
      const [ind2] = indentOf(cont);
      if (ind2 >= 4) cont = stripIndent(cont, 4);
    }
    lines.push(cont);
    j++;
  }
  const text = lines.join('\n');
  const html = ctx.collectOnly ? '' : (ctx.noP ? inlineHtml(text, ctx.refs) : '<p>' + inlineHtml(text, ctx.refs) + '</p>\n');
  return { html, next: j };
}

function parseTable(L, i, end, ctx) {
  const headerCells = splitTableRow(L[i]);
  const aligns = parseDelimiterRow(L[i + 1]);
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < headerCells.length; c++) {
    const a = aligns[c];
    out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + (ctx.collectOnly ? '' : inlineHtml(headerCells[c], ctx.refs)) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  let body = '';
  let j = i + 2;
  while (j < end) {
    const ln = L[j];
    // A line of only tabs is a table row (an empty row), not a blank
    // line; any other blank line ends the table.
    if (isBlank(ln) && !/^\t+$/.test(ln)) break;
    if (startsBlock(ln)) break;
    if (/^ {0,3}\[[^\]]+\]:/.test(ln)) break; // a link definition ends the table
    const cells = splitTableRow(ln);
    body += '<tr>\n';
    for (let c = 0; c < headerCells.length; c++) {
      const a = aligns[c];
      const cell = c < cells.length ? cells[c] : '';
      body += '<td' + (a ? ' align="' + a + '"' : '') + '>' + (ctx.collectOnly ? '' : inlineHtml(cell, ctx.refs)) + '</td>\n';
    }
    body += '</tr>\n';
    j++;
  }
  // A table with no body rows has no <tbody> at all.
  if (body.length > 0) out += '<tbody>' + body + '</tbody>';
  out += '</table>\n';
  return { html: out, next: j };
}

// Parse a list starting at L[i] (a list marker line).
function parseList(L, i, end, ctx) {
  const first = matchListMarker(L[i]);
  const ordered = first.ordered;
  const delim = first.delim;
  const bullet = first.bullet;
  const items = [];
  let j = i;
  let cur = null;
  while (j < end) {
    const line = L[j];
    const lm = matchListMarker(line);
    // A line that is also a thematic break (e.g. `* * *`) is an hr, not
    // a new list item: it ends the list. A marker starts a new item
    // when it is less indented than the current item's content indent
    // — or when the current item was closed by a blank line while
    // still empty (an empty item has no content to nest inside, so
    // any same-type marker at indent 0-3 is a new item).
    if (lm && !matchHr(line) && (cur === null || cur.closed || lm.indent < cur.contentIndent) && lm.ordered === ordered && (ordered ? lm.delim === delim : lm.bullet === bullet)) {
      if (cur) items.push(cur);
      cur = { lines: [], contentIndent: lm.contentIndent, startNum: lm.startNum, task: null, lazyLines: new Set(), closed: false };
      const content = stripColumns(line, lm.contentIndent);
      const tm = /^\[([ xX])\][ \t]/.exec(content);
      if (tm) {
        cur.task = tm[1] !== ' ';
        let k = 3;
        while (k < content.length && (content[k] === ' ' || content[k] === '\t')) k++;
        cur.lines.push(content.slice(k));
      } else {
        cur.lines.push(content);
      }
      j++;
      continue;
    }
    if (!cur) break;
    if (isBlank(line)) {
      // A blank line while the item is still empty closes it: no
      // later indented line can be part of it (a following marker
      // can still start a new item of this list).
      if (cur.lines.every(l => l === '')) cur.closed = true;
      cur.lines.push(''); j++; continue;
    }
    const [ind] = indentOf(line);
    if (ind >= cur.contentIndent) {
      if (cur.closed) break; // a closed empty item takes no content
      cur.lines.push(stripColumns(line, cur.contentIndent));
      j++;
      continue;
    }
    if (endsInOpenPara(cur.lines) && !startsBlock(line)) {
      // A lazy line. Its leading indent is stripped by 4 columns when
      // it is 4 or more (like in a blockquote); a smaller indent is
      // kept. A lazy line that looks like a setext underline is
      // paragraph text, not an underline; and after the strip it can
      // look like a list marker, so record it: the inner parse must
      // treat it as paragraph text, never as a block start.
      const [ind2] = indentOf(line);
      cur.lazyLines.add(cur.lines.length);
      cur.lines.push(ind2 >= 4 ? stripIndent(line, 4) : line);
      j++;
      continue;
    }
    break;
  }
  if (cur) items.push(cur);
  const listEnd = j;
  let loose = false;
  let endsWithBlank = false;
  const renderedItems = [];
  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    let tb = 0;
    while (it.lines.length > 0 && it.lines[it.lines.length - 1] === '') { it.lines.pop(); tb++; }
    if (n === items.length - 1 && tb > 0) endsWithBlank = true;
    // Trailing blank lines count as part of the item only when another
    // item follows (they separate two items); after the last item they
    // are just the separator before the next block. An empty item's
    // own empty line is not a separator: only the blank lines after
    // it count.
    it.trailingBlanks = tb;
    const sepBlanks = tb - (it.lines.length === 0 ? 1 : 0);
    it.hadTrailingBlank = sepBlanks > 0 && n < items.length - 1;
    if (sepBlanks > 0 && n < items.length - 1) loose = true;
    // task checkbox: if the first block is a paragraph, put the input
    // into its inline text; otherwise prepend it to the item body.
    let prependInput = '';
    if (it.task !== null) {
      const input = it.task
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ';
      if (it.lines.length > 0 && isParaLine(it.lines[0])) {
        it.lines[0] = input + it.lines[0];
      } else {
        prependInput = input;
      }
    }
    const childCtx = {
      refs: ctx.refs, docEndsWithNL: ctx.docEndsWithNL,
      lastIsDocEnd: ctx.lastIsDocEnd && listEnd === end && n === items.length - 1,
      inListItem: true, noP: true, collectOnly: ctx.collectOnly,
      topLevel: false, hadTrailingBlank: it.hadTrailingBlank, lazyLines: it.lazyLines,
      inBlockquote: false,
    };
    const inner = parseBlocks(it.lines, 0, it.lines.length, childCtx);
    if (inner.loose) loose = true;
    renderedItems.push({ html: prependInput + inner.html });
  }
  let html;
  if (ordered) {
    html = '<ol' + (first.startNum !== 1 ? ' start="' + first.startNum + '"' : '') + '>\n';
  } else {
    html = '<ul>\n';
  }
  for (const it of renderedItems) {
    html += '<li>' + it.html + '</li>\n';
  }
  html += ordered ? '</ol>\n' : '</ul>\n';
  // If the list is loose, re-render the items with <p> wrappers. We
  // already parsed them tight; redo them loose when needed. (Skipped in
  // the definition-collection pass, where only the structure matters.)
  if (loose && !ctx.collectOnly) {
    const looseItems = [];
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      const childCtx = {
        refs: ctx.refs, docEndsWithNL: ctx.docEndsWithNL,
        lastIsDocEnd: ctx.lastIsDocEnd && listEnd === end && n === items.length - 1,
        inListItem: true, noP: false, collectOnly: ctx.collectOnly,
        topLevel: false, hadTrailingBlank: it.hadTrailingBlank, lazyLines: it.lazyLines,
        inBlockquote: false,
      };
      const inner = parseBlocks(it.lines, 0, it.lines.length, childCtx);
      looseItems.push(inner.html);
    }
    html = ordered
      ? '<ol' + (first.startNum !== 1 ? ' start="' + first.startNum + '"' : '') + '>\n'
      : '<ul>\n';
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      let prependInput = '';
      if (it.task !== null && it.lines.length > 0 && !isParaLine(it.lines[0])) {
        prependInput = it.task
          ? '<input checked="" disabled="" type="checkbox"> '
          : '<input disabled="" type="checkbox"> ';
      }
      html += '<li>' + prependInput + looseItems[n] + '</li>\n';
    }
    html += ordered ? '</ol>\n' : '</ul>\n';
  }
  return { html, next: listEnd, endsWithBlank };
}

// --- entry point -----------------------------------------------------------
export function parse(markdown) {
  const src = markdown.replace(/\r\n?/g, '\n');
  const docEndsWithNL = src.length === 0 || src.endsWith('\n');
  const rawLines = src.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const refs = new Map();
  const ctx = { refs, docEndsWithNL, lastIsDocEnd: true, inListItem: false, noP: false, collectOnly: false, topLevel: true, hadTrailingBlank: false, inBlockquote: false };
  // First pass: collect link reference definitions. They may be defined
  // after their first use, and inside blockquotes / list items, so they
  // have to be known before any inline text is rendered. This pass runs
  // the same block dispatch as the real parse (minus inline rendering),
  // so it finds definitions in exactly the places the real parse would.
  parseBlocks(rawLines, 0, rawLines.length, { refs, docEndsWithNL, lastIsDocEnd: true, inListItem: false, noP: false, collectOnly: true, topLevel: true, hadTrailingBlank: false, inBlockquote: false });
  return parseBlocks(rawLines, 0, rawLines.length, ctx).html;
}
export default parse;
