// parse.js -- a fast, dependency-free CommonMark 0.31.2 + GFM 0.29 renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders
// with its defaults (GFM on, breaks off), for every input string.
// Written from the two specs and verified against marked case by case.
// No caching across calls, no input recognition: every call parses the
// string it is given, from the top, and keeps nothing from earlier calls.
//
// Speed design: the block level is a line-based state machine; the inline
// level is a stride scanner that copies plain-text runs with one slice
// per run instead of one step per character, and resolves emphasis with
// a small delimiter-stack pass. Plain text with no inline construct at
// all takes a fast path that returns it unchanged. Hot paths avoid
// regular expressions and per-character string allocation.

const REPLACEMENT = '�';

// ---- small character helpers ----
function isSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
}
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isAlphaNum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isDigit(c) {
  return c >= 48 && c <= 57;
}
function isHex(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}
const PUNCT_RE = /[\p{P}\p{S}]/u;
// Character class for emphasis flanking: 0 whitespace, 1 punctuation, 2 other.
// Out of range counts as whitespace.
function charClass(s, i) {
  if (i < 0 || i >= s.length) return 0;
  const c = s.charCodeAt(i);
  if (isSpace(c)) return 0;
  if (c < 128) return isAsciiPunct(c) ? 1 : 2;
  // Unicode whitespace (Zs, Zl, Zp) counts as whitespace for flanking.
  if (c === 160 || c === 1680 || (c >= 8192 && c <= 8202) || c === 8239 || c === 8287 || c === 12288 || c === 8232 || c === 8233) return 0;
  return PUNCT_RE.test(String.fromCodePoint(s.codePointAt(i))) ? 1 : 2;
}

// Escape &, <, >, " and ' for text and attribute values. One native
// regex test covers the common no-specials case; when escaping is
// needed, five chained native replaces beat a character loop in JS
// (& first, so the & introduced by later replacements stays literal).
const ESC_TEST_RE = /[&<>"']/;
function esc(s) {
  if (!ESC_TEST_RE.test(s)) return s;
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// marked encodes link destinations with encodeURI, then HTML-escapes them
// (entity-aware: &name; and valid numeric references stay verbatim).
// Fast path: when the URL holds only characters encodeURI leaves alone
// (plus '%', which encodeURI turns into %25 and marked reverts), the
// encode step is the identity, so skip it.
const HREF_SAFE_RE = /[^A-Za-z0-9;,/?:@&=+$_.!~*'()#%-]/;
function encodeHref(s) {
  if (s === '') return '';
  if (!HREF_SAFE_RE.test(s)) return escAttr(s);
  try {
    // marked leaves '%' unencoded: encodeURI's %25 is reverted.
    return escAttr(encodeURI(s).replace(/%25/g, '%'));
  } catch (_e) {
    return escAttr(s);
  }
}

// Decode a numeric character reference starting at s[i] === '&'.
// Returns {ch, end} or null when it is not a valid numeric reference.
// Valid: &#<1-7 decimal digits>; or &#x<1-6 hex digits>; (x case-insensitive).
// The value must not be 0, a surrogate, or above U+10FFFF.
function numericEntity(s, i) {
  if (s.charCodeAt(i + 1) !== 35) return null;
  let j = i + 2;
  let hex = false;
  const c = s.charCodeAt(j);
  if (c === 120 || c === 88) {
    hex = true;
    j++;
  }
  const start = j;
  let value = 0;
  if (hex) {
    while (j < s.length && isHex(s.charCodeAt(j))) {
      const d = s.charCodeAt(j);
      value = value * 16 + (d >= 48 && d <= 57 ? d - 48 : d >= 65 && d <= 70 ? d - 55 : d - 87);
      j++;
      if (j - start > 6) return null;
    }
  } else {
    while (j < s.length && isDigit(s.charCodeAt(j))) {
      value = value * 10 + (s.charCodeAt(j) - 48);
      j++;
      if (j - start > 7) return null;
    }
  }
  if (j === start) return null;
  if (j >= s.length || s.charCodeAt(j) !== 59) return null;
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return { ch: REPLACEMENT, end: j + 1 };
  return { ch: String.fromCodePoint(value), end: j + 1 };
}

// A named entity reference &name; at s[i]. Named references are passed
// through verbatim (marked does not decode them). Returns the end index
// after the ';', or -1.
function namedEntityEnd(s, i) {
  let j = i + 1;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    // A named entity needs at least one name character: "&;" on its
    // own is not an entity, marked escapes the & ("&amp;;").
    if (c === 59) return j > i + 1 ? j + 1 : -1;
    if (!isAlphaNum(c) && c !== 95) return -1;
    j++;
  }
  return -1;
}

// Unescape backslash escapes in a raw string (link destinations, titles,
// labels). Entity references stay verbatim: marked does not decode them
// in destinations or titles, it only leaves them unescaped in attributes.
function unescapeStr(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// Escape an attribute value: <, >, " and ' are always escaped, and & is
// escaped unless it starts a reference that stays verbatim -- a named
// reference &name;, or a numeric reference with at most 7 decimal or 6
// hex digits followed by ';'.
function escAttr(s) {
  if (!ESC_TEST_RE.test(s)) return s;
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      let j = i + 1;
      let ok = false;
      if (s.charCodeAt(j) === 35) {
        j++;
        if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) j++;
        const ds = j;
        while (j < s.length && isHex(s.charCodeAt(j))) j++;
        if (j > ds && j - ds <= 7 && s.charCodeAt(j) === 59) ok = true;
      } else {
        while (j < s.length && (isAlphaNum(s.charCodeAt(j)) || s.charCodeAt(j) === 95)) j++;
        if (j > i + 1 && s.charCodeAt(j) === 59) ok = true;
      }
      if (ok) continue;
      if (start < i) out.push(s.slice(start, i));
      out.push('&amp;');
      start = i + 1;
      continue;
    }
    let rep = null;
    if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (start < i) out.push(s.slice(start, i));
      out.push(rep);
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  else if (start === 0) out.push(s);
  return out.join('');
}

// Normalise a link label for reference lookup: collapse whitespace runs
// to one space, trim, and Unicode case-fold. Backslash escapes are NOT
// decoded: labels compare raw, so [foo\!] does not match [foo!].
function normalizeLabel(raw) {
  // A label cannot contain an unescaped '[' (a '[' preceded by an odd
  // run of backslashes is escaped; an even run leaves it bare).
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) === 91) {
      let bs = 0;
      let k = i - 1;
      while (k >= 0 && raw.charCodeAt(k) === 92) {
        bs++;
        k--;
      }
      if (bs % 2 === 0) return null;
    }
  }
  const s = raw;
  let out = '';
  let inWs = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isSpace(c)) {
      if (!inWs) {
        out += ' ';
        inWs = true;
      }
    } else {
      out += s[i];
      inWs = false;
    }
  }
  if (out.length > 0 && out.charCodeAt(out.length - 1) === 32) out = out.slice(0, -1);
  // An empty label (whitespace only) is invalid.
  if (out.length === 0) return null;
  return foldCase(out);
}

// Unicode case folding for label matching: full case folding maps
// eszett and ligatures to their expansions, and final sigma to sigma.
function foldCase(s) {
  const l = s.toLowerCase();
  if (l.indexOf('ß') < 0 && l.indexOf('ς') < 0 && l.indexOf('ﬀ') < 0 && l.indexOf('ﬁ') < 0 && l.indexOf('ﬂ') < 0 && l.indexOf('ﬃ') < 0 && l.indexOf('ﬄ') < 0 && l.indexOf('ﬅ') < 0 && l.indexOf('ﬆ') < 0) return l;
  return l.replace(/ß/g, 'ss').replace(/ς/g, 'σ').replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
}

// ---- tab / column helpers for block parsing ----
// Advance `n` columns from (pos, col) in `line`. A tab that straddles
// the target is expanded to spaces so the remainder survives.
function advanceCols(line, pos, col, n) {
  const target = col + n;
  let i = pos;
  let c0 = col;
  while (i < line.length && c0 < target) {
    const ch = line.charCodeAt(i);
    if (ch === 32) {
      c0++;
      i++;
    } else if (ch === 9) {
      const next = c0 + 4 - (c0 % 4);
      if (next <= target) {
        c0 = next;
        i++;
      } else {
        const left = target - c0;
        line = line.slice(0, i) + ' '.repeat(left) + ' '.repeat(next - target) + line.slice(i + 1);
        i += left;
        c0 = target;
      }
    } else break;
  }
  return { line, pos: i, col: c0 };
}

// ---- inline parsing helpers ----

// End index (exclusive) of an inline HTML tag starting at s[i] === '<',
// or -1 when it is not a tag. Covers open/close tags, comments,
// processing instructions, declarations and CDATA sections.
function htmlTagEnd(s, i) {
  const n = s.length;
  if (i + 1 >= n) return -1;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 33) {
    if (s.startsWith('<!--', i)) {
      // Abruptly closed empty comments.
      if (s.startsWith('<!-->', i)) return i + 5;
      if (s.startsWith('<!--->', i)) return i + 6;
      const e = s.indexOf('-->', i + 4);
      return e < 0 ? -1 : e + 3;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      return e < 0 ? -1 : e + 3;
    }
    if (i + 2 < n && isAlphaNum(s.charCodeAt(i + 2))) {
      const e = s.indexOf('>', i + 2);
      return e < 0 ? -1 : e + 1;
    }
    return -1;
  }
  if (c1 === 63) {
    const e = s.indexOf('?>', i + 2);
    return e < 0 ? -1 : e + 2;
  }
  let j = i + 1;
  let closing = false;
  if (s.charCodeAt(j) === 47) {
    closing = true;
    j++;
  }
  if (j >= n) return -1;
  const c = s.charCodeAt(j);
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return -1;
  while (j < n && (isAlphaNum(s.charCodeAt(j)) || s.charCodeAt(j) === 45)) j++;
  // A closing tag takes only whitespace then '>'. An open tag's
  // attributes must each be preceded by whitespace.
  if (closing) {
    while (j < n && isSpace(s.charCodeAt(j))) j++;
    return j < n && s.charCodeAt(j) === 62 ? j + 1 : -1;
  }
  while (j < n) {
    const d = s.charCodeAt(j);
    if (d === 62) return j + 1;
    if (d === 47) {
      if (j + 1 < n && s.charCodeAt(j + 1) === 62) return j + 2;
      return -1;
    }
    if (!isSpace(d)) return -1;
    while (j < n && isSpace(s.charCodeAt(j))) j++;
    if (j >= n) return -1;
    const e0 = s.charCodeAt(j);
    if (e0 === 62) return j + 1;
    if (e0 === 47) {
      if (j + 1 < n && s.charCodeAt(j + 1) === 62) return j + 2;
      return -1;
    }
    // Parse attribute name.
    if (!((e0 >= 65 && e0 <= 90) || (e0 >= 97 && e0 <= 122) || e0 === 95 || e0 === 58)) return -1;
    j++;
    while (j < n) {
      const e = s.charCodeAt(j);
      if (isAlphaNum(e) || e === 95 || e === 58 || e === 46 || e === 45) j++;
      else break;
    }
    // Look for '=' after optional whitespace.
    let k = j;
    while (k < n && isSpace(s.charCodeAt(k))) k++;
    if (k < n && s.charCodeAt(k) === 61) {
      j = k + 1;
      while (j < n && isSpace(s.charCodeAt(j))) j++;
      if (j < n && (s.charCodeAt(j) === 34 || s.charCodeAt(j) === 39)) {
        const q = s[j];
        const e = s.indexOf(q, j + 1);
        if (e < 0) return -1;
        j = e + 1;
      } else {
        let m = j;
        while (m < n) {
          const e = s.charCodeAt(m);
          if (isSpace(e) || e === 34 || e === 39 || e === 61 || e === 60 || e === 62 || e === 96) break;
          m++;
        }
        if (m === j) return -1;
        j = m;
      }
      // After a value, the next char must be whitespace, '/' or '>'.
      if (j < n && !isSpace(s.charCodeAt(j)) && s.charCodeAt(j) !== 62 && s.charCodeAt(j) !== 47) return -1;
    } else {
      // No value (a boolean attribute): the char after the name must
      // be whitespace, '/' or '>'. Leave j at that char so the loop
      // top sees the whitespace before the next attribute.
      if (j < n && !isSpace(s.charCodeAt(j)) && s.charCodeAt(j) !== 62 && s.charCodeAt(j) !== 47) return -1;
    }
  }
  return -1;
}

function isEmailLocalChar(c) {
  const code = c.charCodeAt(0);
  if (isAlphaNum(code)) return true;
  return '.!#$%&\'*+/=?^_`{|}~-'.indexOf(c) >= 0;
}

function isValidDomain(dom, allowUnderscore) {
  if (!dom) return false;
  let start = 0;
  for (let i = 0; i <= dom.length; i++) {
    if (i === dom.length || dom.charCodeAt(i) === 46) {
      const lab = dom.slice(start, i);
      if (lab.length === 0 || lab.length > 63) return false;
      if (!allowUnderscore) {
        if (!isAlphaNum(lab.charCodeAt(0)) || !isAlphaNum(lab.charCodeAt(lab.length - 1))) return false;
        for (let k = 1; k < lab.length - 1; k++) {
          const c = lab.charCodeAt(k);
          if (!isAlphaNum(c) && c !== 45) return false;
        }
      } else {
        for (let k = 0; k < lab.length; k++) {
          const c = lab.charCodeAt(k);
          if (!isAlphaNum(c) && c !== 45 && c !== 95) return false;
        }
      }
      start = i + 1;
    }
  }
  return true;
}

// <scheme:...> or <email> autolink starting at s[i] === '<'.
// Returns {end, href, text} or null.
function parseAutolinkAt(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      let k = j + 1;
      while (k < n && (isAlphaNum(s.charCodeAt(k)) || s[k] === '+' || s[k] === '.' || s[k] === '-')) k++;
      if (k - j >= 2 && k - j <= 32 && k < n && s.charCodeAt(k) === 58) {
        let e = k + 1;
        while (e < n && s.charCodeAt(e) !== 62 && !isSpace(s.charCodeAt(e)) && s.charCodeAt(e) !== 60) e++;
        if (e < n && s.charCodeAt(e) === 62 && e > k + 1) {
          return { end: e + 1, href: s.slice(i + 1, e), text: s.slice(i + 1, e) };
        }
        return null;
      }
    }
  }
  let e = i + 1;
  let at = -1;
  while (e < n && s.charCodeAt(e) !== 62 && !isSpace(s.charCodeAt(e)) && s.charCodeAt(e) !== 60) {
    if (s.charCodeAt(e) === 64) {
      at = e;
      break;
    }
    e++;
  }
  if (at > i + 1) {
    let ok = true;
    for (let k = i + 1; k < at; k++) {
      if (!isEmailLocalChar(s[k])) {
        ok = false;
        break;
      }
    }
    if (ok) {
      let d = at + 1;
      while (d < n && s.charCodeAt(d) !== 62) d++;
      const dom = s.slice(at + 1, d);
      if (d < n && d > at + 1 && dom.indexOf('.') >= 0 && isValidDomain(dom)) {
        const u = s.slice(i + 1, d);
        return { end: d + 1, href: 'mailto:' + u, text: u };
      }
    }
  }
  return null;
}

// A link's text is invalid when it holds a backtick run with no
// matching closer, or a code span whose content itself holds a
// backtick and which is not the last thing before the ']'. Either
// case makes marked leave the whole [...](...) literal.
function linkTextBadBacktick(t) {
  let i = 0;
  const n = t.length;
  let unpaired = 0;
  while (i < n) {
    const c = t.charCodeAt(i);
    if (c === 92) { i += 2; continue; }
    if (c !== 96) { i++; continue; }
    let m = 0;
    while (i + m < n && t.charCodeAt(i + m) === 96) m++;
    let j = i + m;
    let found = -1;
    while (j < n) {
      if (t.charCodeAt(j) === 92) { j += 2; continue; }
      if (t.charCodeAt(j) === 96) {
        let r = 0;
        while (j + r < n && t.charCodeAt(j + r) === 96) r++;
        if (r === m) { found = j; break; }
        j += r;
      } else j++;
    }
    if (found >= 0) {
      let hasInner = false;
      for (let k = i + m; k < found; k++) {
        if (t.charCodeAt(k) === 92) { k++; continue; }
        if (t.charCodeAt(k) === 96) { hasInner = true; break; }
      }
      if (hasInner && found + m < n) return true;
      i = found + m;
    } else {
      unpaired++;
      i += m;
    }
  }
  return (unpaired % 2) !== 0;
}

// Lengths of backtick runs in t that do not close a code span within t
// (dangling runs). Marked's emphasis mask lets such a run pair with a
// later backtick run of the same length outside the link text, forming
// a phantom code span that hides any emphasis delimiters inside it.
function danglingBacktickLens(t) {
  const lens = [];
  let i = 0;
  const n = t.length;
  while (i < n) {
    const c = t.charCodeAt(i);
    if (c === 92) { i += 2; continue; }
    if (c !== 96) { i++; continue; }
    let m = 0;
    while (i + m < n && t.charCodeAt(i + m) === 96) m++;
    let j = i + m;
    let found = -1;
    while (j < n) {
      if (t.charCodeAt(j) === 92) { j += 2; continue; }
      if (t.charCodeAt(j) === 96) {
        let r = 0;
        while (j + r < n && t.charCodeAt(j + r) === 96) r++;
        if (r === m) { found = j; break; }
        j += r;
      } else j++;
    }
    if (found >= 0) i = found + m;
    else { lens.push(m); i += m; }
  }
  return lens;
}

// Find the ']' matching the '[' at s[start]; -1 if none. Skips escaped
// brackets and code spans, and counts nested brackets.
function findClosingBracket(s, start) {
  let depth = 0;
  let i = start + 1;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      i += 2;
      continue;
    }
    if (c === 60) {
      // A '<' may start an autolink (<scheme:...> or <email>) or an HTML
      // tag whose quoted attribute holds a ']'; skip the whole thing so
      // that ']' does not close the link.
      const al = parseAutolinkAt(s, i);
      if (al) {
        i = al.end;
        continue;
      }
      const he = htmlTagEnd(s, i);
      if (he > 0) {
        i = he;
        continue;
      }
    }
    if (c === 96) {
      let m = 0;
      while (i + m < n && s.charCodeAt(i + m) === 96) m++;
      let j = i + m;
      let found = -1;
      while (j < n) {
        // A ']' at depth 0 closes the link, so a code span whose closer
        // lies past it cannot swallow that bracket.
        if (depth === 0 && s.charCodeAt(j) === 93) break;
        if (s.charCodeAt(j) === 96) {
          let r = 0;
          while (j + r < n && s.charCodeAt(j + r) === 96) r++;
          if (r === m) {
            found = j;
            break;
          }
          j += r;
        } else j++;
      }
      if (found < 0) {
        i += m;
        continue;
      }
      i = found + m;
      continue;
    }
    if (c === 91) {
      depth++;
      i++;
      continue;
    }
    if (c === 93) {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// Parse (dest title) starting just after '(' at s[pos]. Returns null on failure.
function parseDestTitle(s, pos) {
  const n = s.length;
  let i = pos;
  while (i < n && isSpace(s.charCodeAt(i))) i++;
  let dest = '';
  if (i < n && s.charCodeAt(i) === 60) {
    let j = i + 1;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
        j += 2;
        continue;
      }
      if (c === 62 || c === 10 || c === 60) break;
      j++;
    }
    if (j >= n || s.charCodeAt(j) !== 62) return null;
    dest = s.slice(i + 1, j);
    i = j + 1;
  } else {
    let depth = 0;
    let j = i;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (isSpace(c) || c < 32) break;
      if (c === 92) {
        j += 2;
        continue;
      }
      if (c === 40) {
        depth++;
        j++;
        continue;
      }
      if (c === 41) {
        if (depth === 0) break;
        depth--;
        j++;
        continue;
      }
      j++;
    }
    dest = s.slice(i, j);
    i = j;
  }
  let k = i;
  while (k < n && isSpace(s.charCodeAt(k))) k++;
  let title = null;
  if (k < n && (s.charCodeAt(k) === 34 || s.charCodeAt(k) === 39 || s.charCodeAt(k) === 40)) {
    const q = s.charCodeAt(k);
    const close = q === 40 ? 41 : q;
    let j = k + 1;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
        j += 2;
        continue;
      }
      if (c === close) break;
      if (q === 40 && c === 40) return null;
      j++;
    }
    if (j >= n || s.charCodeAt(j) !== close) return null;
    title = s.slice(k + 1, j);
    k = j + 1;
    while (k < n && isSpace(s.charCodeAt(k))) k++;
  }
  if (k >= n || s.charCodeAt(k) !== 41) return null;
  return { dest, title, end: k + 1 };
}

// Trim trailing punctuation off an extended autolink candidate (GFM rules):
// trailing ? ! . , : ; * _ ~, unbalanced closing parens, and a trailing
// entity-like ; (whose &...; stays out of the link).
function trimExtUrl(u) {
  while (u.length > 0) {
    const last = u.charCodeAt(u.length - 1);
    if (last === 59) {
      const amp = u.lastIndexOf('&');
      if (amp >= 0) {
        const mid = u.slice(amp + 1, u.length - 1);
        let ent = mid.length > 0;
        for (let k = 0; k < mid.length; k++) {
          if (!isAlphaNum(mid.charCodeAt(k)) && mid.charCodeAt(k) !== 35 && mid.charCodeAt(k) !== 95) {
            ent = false;
            break;
          }
        }
        if (ent) {
          // A trailing entity-like &...; stays out of the link entirely.
          u = u.slice(0, amp);
          continue;
        }
      }
      u = u.slice(0, -1);
      continue;
    }
    if (last === 63 || last === 33 || last === 46 || last === 44 || last === 58 || last === 42 || last === 95 || last === 126) {
      u = u.slice(0, -1);
      continue;
    }
    if (last === 41) {
      // A trailing ')' is dropped while ')' outnumber '(' — but a ')'
      // immediately followed by ']' is a stray that does not take part
      // in balancing (it belongs to the preceding ']' segment, as in
      // https://a.com)](https://b.com) where the final ')' balances
      // the '(' after the ']').
      let open = 0;
      let close = 0;
      for (let k = 0; k < u.length; k++) {
        const c = u.charCodeAt(k);
        if (c === 40) open++;
        else if (c === 41 && u.charCodeAt(k + 1) !== 93) close++;
      }
      if (close > open) {
        u = u.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return u;
}

// Resolve emphasis / strong / strikethrough delimiters in a node list.
// Delimiter nodes are {t:'d', ch, n, o, c} (can-open, can-close). Runs that
// survive become literal text when the list is rendered.
function resolveDelims(nodes) {
  const openers = [];
  let i = 0;
  // Each time a delimiter that could both open and close is consumed as
  // a closer for an inner emphasis opened by a LEFT delimiter, record
  // its length (per char) with a sequence number. A later closer may
  // not pair with an opener pushed before that inner closer when the
  // inner closer would have been skipped by marked's rule of three for
  // that opener -- i.e. (opener.n + inner.n) % 3 === 0 while
  // opener.n % 3 !== 0 -- because marked's forward scan then never
  // clears the debt. Except for a strong-strong pair (both runs >= 2),
  // which still pairs. Openers pushed after the inner closer are fresh
  // and pair normally. Each opener records the sequence it was pushed
  // at, in `gen`.
  const bothByCh = Object.create(null);
  let bothSeq = 0;
  // Openers already refused by the both-closer rule for an earlier
  // closer: a later strong closer may fall through them, but a first
  // refusal stops the search.
  const refused = new Set();
  while (i < nodes.length) {
    const node = nodes[i];
    if (node.t !== 'd') {
      i++;
      continue;
    }
    let done = false;
    if (node.c && node.n > 0) {
      for (let sIdx = openers.length - 1; sIdx >= 0; sIdx--) {
        const o = openers[sIdx];
        if (o.ch !== node.ch || o.n <= 0 || !o.o) continue;
        // Rule of three: when either delimiter can both open and close,
        // a combined length divisible by 3 cannot pair, unless both
        // lengths are themselves multiples of 3. When the nearest opener
        // is blocked, marked usually does NOT fall back to an earlier
        // opener (the closer stays literal) -- except when the blocking
        // opener is longer than the closer, in which case the closer
        // falls through to an earlier opener (cm-412: `*foo**bar*`).
        // So: fall through only when o.n > node.n, otherwise stop.
        if (((o.o && o.c) || (node.o && node.c)) && ((o.n + node.n) % 3 === 0) && (o.n % 3 !== 0 || node.n % 3 !== 0)) {
          if (o.n > node.n) continue;
          break;
        }
        let fContrib = false;
        if (node.ch !== '~') {
          const list = bothByCh[node.ch];
          if (list) {
            let blocked = false;
            let blockRec = null;
            // A record that would block but is skipped by a strong-strong
            // exception means marked's scan skipped that inner BOTH
            // delimiter (rule of three), raising its `f` accumulator, so
            // the effective closer length grows and any spare delimiters
            // land INSIDE the wrapper (M.slice) rather than after it.
            for (let b = 0; b < list.length; b++) {
              const rec = list[b];
              const wouldBlock = rec.seq >= (o.gen || 0) && o.n % 3 !== 0 && ((o.n + rec.len) % 3 === 0);
              // A record spent by an earlier single closer no longer
              // blocks a strong closer on a strong opener. A strong
              // closer longer than its strong opener is not blocked
              // either: it has spare delimiters beyond the pair.
              if (rec.spent && node.n >= 2 && o.n >= 2) { if (wouldBlock) fContrib = true; continue; }
              if (node.n > o.n && o.n >= 2 && node.n >= 2) { if (wouldBlock) fContrib = true; continue; }
              if (wouldBlock) { blocked = true; blockRec = rec; break; }
            }
            // A strong closer (n>=2) blocked on a single opener falls
            // through to an earlier strong opener only when that opener
            // was already refused for an earlier closer; a first
            // refusal stops the search.
            if (blocked) {
              if (node.n === 1 && blockRec) blockRec.spent = true;
              if (node.n >= 2 && o.n === 1 && refused.has(o)) continue;
              refused.add(o);
              break;
            }
          }
        }
        let use = o.n >= 2 && node.n >= 2 ? 2 : 1;
        // Strikethrough pairs only when both runs have the same length.
        if (node.ch === '~') {
          if (o.n !== node.n) continue;
          use = node.n;
        }
        const oIdx = nodes.indexOf(o);
        const dIdx = nodes.indexOf(node);
        if (oIdx < 0 || dIdx < 0 || oIdx >= dIdx) continue;
        const children = nodes.slice(oIdx + 1, dIdx);
        const tag = node.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
        const wrapper = { t: tag, children };
        const replacement = [];
        let newO = null;
        let newD = null;
        if (o.n > use) {
          newO = { t: 'd', ch: o.ch, n: o.n - use, o: o.o, c: o.c, gen: o.gen };
          replacement.push(newO);
        }
        replacement.push(wrapper);
        if (node.n > use) {
          newD = { t: 'd', ch: node.ch, n: node.n - use, o: node.o, c: node.c };
          // Spare delimiters land inside the wrapper when marked's `f`
          // accumulator grew (a bothByCh record was skipped above);
          // otherwise they stay after the wrapper.
          if (fContrib) children.push(newD);
          else replacement.push(newD);
        }
        nodes.splice(oIdx, dIdx - oIdx + 1, ...replacement);
        openers.splice(sIdx, 1);
        if (newO) openers.splice(sIdx, 0, newO);
        // Only when the inner emphasis was opened by a LEFT delimiter
        // (open-only, e.g. `**` after a space) and closed by a BOTH one.
        // If the opener was itself BOTH (cm-411 `**bar**`, cm-416
        // `***bar***`), marked skips it in its scan, no debt is raised,
        // and an outer pair may still form.
        if (node.o && node.c && o.o && !o.c && node.ch !== '~') {
          (bothByCh[node.ch] || (bothByCh[node.ch] = [])).push({ seq: bothSeq, len: node.n });
          bothSeq++;
        }
        i = oIdx + (newO ? 1 : 0) + 1;
        done = true;
        break;
      }
    }
    if (done) continue;
    if (node.o && node.n > 0 && openers.indexOf(node) < 0) {
      if (node.gen === undefined) node.gen = bothSeq;
      openers.push(node);
    }
    i++;
  }
}

// Render a prepared node list to HTML. `refs` is the document's link
// reference map. Link text is stored raw and parsed here, so emphasis
// inside link text is scoped to the link.
function emitNodes(nodes, refs) {
  let out = '';
  for (const node of nodes) {
    if (node.t === 'x') out += node.s;
    else if (node.t === 'code') out += '<code>' + node.s + '</code>';
    else if (node.t === 'html') out += node.s;
    else if (node.t === 'br') out += node.hard ? '<br>' : '\n';
    else if (node.t === 'd') out += node.ch.repeat(node.n);
    else if (node.t === 'link') {
      out += '<a href="' + node.href + '"';
      if (node.title !== null && node.title !== undefined) out += ' title="' + node.title + '"';
      if (node.plain) {
        out += '>' + esc(node.text) + '</a>';
      } else {
        // Link text is parsed with inLink set, so bare GFM autolinks
        // (www, http, email) stay plain inside it; explicit <...>
        // autolinks still render.
        const saved = inLink;
        inLink = true;
        out += '>' + parseInline(node.text, refs) + '</a>';
        inLink = saved;
      }
    } else if (node.t === 'img') {
      out += '<img src="' + node.href + '" alt="' + node.alt + '"';
      if (node.title !== null && node.title !== undefined) out += ' title="' + node.title + '"';
      out += '>';
    } else if (node.t === 'em' || node.t === 'strong' || node.t === 'del') {
      out += '<' + node.t + '>' + emitNodes(node.children, refs) + '</' + node.t + '>';
    }
  }
  return out;
}

// Plain-text rendering of a node list (image alt text): tags are dropped,
// code and HTML contribute their literal text.
function plainNodes(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.t === 'x') out += node.raw;
    else if (node.t === 'code') out += node.raw;
    else if (node.t === 'html') out += node.s;
    else if (node.t === 'br') out += '\n';
    else if (node.t === 'd') out += node.ch.repeat(node.n);
    else if (node.t === 'link') out += node.plain ? node.text : plainInline(node.text);
    else if (node.t === 'img') out += node.alt;
    else if (node.t === 'em' || node.t === 'strong' || node.t === 'del') out += plainNodes(node.children);
  }
  return out;
}
function plainInline(s, refs) {
  const nodes = scanInline(s, refs || new Map());
  resolveDelims(nodes);
  return plainNodes(nodes);
}

// ---- the inline scanner ----
// Case-insensitive ASCII prefix match: does `s` starting at `i` match `pat`?
function startsWithCI(s, i, pat) {
  if (i + pat.length > s.length) return false;
  for (let k = 0; k < pat.length; k++) {
    let a = s.charCodeAt(i + k);
    let b = pat.charCodeAt(k);
    if (a >= 65 && a <= 90) a += 32;
    if (b >= 65 && b <= 90) b += 32;
    if (a !== b) return false;
  }
  return true;
}

// Whether an inline <a> tag is open somewhere earlier in this document
// (marked's lexer inLink state). While it is open, GFM extended
// autolinks (bare emails, www., http://) are not recognised; a closing
// </a> restores them. Reset per document in parse().
let inLink = false;

// The stride pattern for the inline scanner: one native regex scan finds
// the next character (or autolink prefix) that needs a branch, instead
// of stepping through plain text one character at a time in JS. The
// regex may stop at an autolink starter the branch then rejects (wrong
// case, no word boundary, inside a link); the branch appends one char
// and the scan resumes, so the result is identical to stopping only
// where a branch can act.
const STRIDE_RE = /[\\`*_~<&\[!@\n]|www\.|https?:\/\/|ftp:\/\/|mailto:|xmpp:/gi;

// Whether a node list holds a real (non-plain) link anywhere, including
// inside emphasis wrappers.
function nodesHaveLink(ns) {
  for (const nd of ns) {
    if (nd.t === 'link' && !nd.plain) return true;
    if (nd.children && nodesHaveLink(nd.children)) return true;
  }
  return false;
}

// Scans `s` left to right and builds a node list. Text runs are stored
// raw (node.raw) and escaped (node.s); code spans, links, autolinks and
// HTML become their own nodes; emphasis / strikethrough runs become
// delimiter nodes that resolveDelims() turns into <em>/<strong>/<del>.
// The scan strides over plain text: a run of ordinary characters is
// copied with a single slice instead of one step per character.
function scanInline(s, refs) {
  const nodes = [];
  let buf = '';
  // Index just past the end of a failed inline link's bracket span: while
  // scanning inside it, * and _ runs are literal text (marked does not
  // parse emphasis inside a [...](invalid) that failed to become a link).
  let suppressDelimsUntil = -1;
  // Buffer length just after the most recent backslash escape that added
  // a char to buf (0 when the current run holds no escaped char). An
  // email's local part starts after the last escape, not before it.
  let lastEsc = 0;
  const flush = () => {
    if (buf !== '') {
      nodes.push({ t: 'x', s: esc(buf), raw: buf });
      buf = '';
    }
    lastEsc = 0;
  };
  const n = s.length;
  let i = 0;
  while (i < n) {
    STRIDE_RE.lastIndex = i;
    const m = STRIDE_RE.exec(s);
    const stop = m ? m.index : n;
    if (stop > i) {
      buf += s.slice(i, stop);
      i = stop;
      if (i >= n) break;
    }
    const code = s.charCodeAt(i);
    if (code === 92) {
      // Backslash escape, or a hard break before a newline.
      if (i + 1 < n) {
        const nc = s.charCodeAt(i + 1);
        if (isAsciiPunct(nc)) {
          buf += s[i + 1];
          lastEsc = buf.length;
          i += 2;
          continue;
        }
        if (nc === 10) {
          flush();
          nodes.push({ t: 'br', hard: true });
          i += 2;
          // A hard break strips the next line's leading indentation.
          while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
          continue;
        }
      }
      buf += '\\';
      i++;
      continue;
    }
    if (code === 96) {
      // Code span: a run of backticks closed by a run of the same length.
      let j = i;
      while (j < n && s.charCodeAt(j) === 96) j++;
      const runLen = j - i;
      let k = j;
      let close = -1;
      while (k < n) {
        const nb = s.indexOf('`', k);
        if (nb < 0) break;
        k = nb;
        let m = 0;
        while (k + m < n && s.charCodeAt(k + m) === 96) m++;
        if (m === runLen) {
          close = k;
          break;
        }
        k += m;
      }
      if (close < 0) {
        buf += s.slice(i, j);
        i = j;
        continue;
      }
      let content = s.slice(j, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ t: 'code', s: esc(content), raw: content });
      i = close + runLen;
      continue;
    }
    if (code === 60) {
      const al = parseAutolinkAt(s, i);
      if (al) {
        flush();
        nodes.push({ t: 'link', href: encodeHref(al.href), title: null, text: al.text, plain: true });
        i = al.end;
        continue;
      }
      const he = htmlTagEnd(s, i);
      if (he > 0) {
        // An inline <a ...> opens the document-wide inLink state and
        // a literal </a> closes it (marked's startATag/endATag rules:
        // <a needs a space after it, </a> needs nothing after it).
        const c1 = s.charCodeAt(i + 1);
        if (!inLink && (c1 === 97 || c1 === 65) && s.charCodeAt(i + 2) === 32) {
          inLink = true;
        } else if (inLink && c1 === 47 && (s.charCodeAt(i + 2) === 97 || s.charCodeAt(i + 2) === 65) && s.charCodeAt(i + 3) === 62) {
          inLink = false;
        }
        flush();
        nodes.push({ t: 'html', s: s.slice(i, he) });
        i = he;
        continue;
      }
      buf += '<';
      i++;
      continue;
    }
    if (code === 38) {
      const ne = numericEntity(s, i);
      if (ne) {
        buf += ne.ch;
        i = ne.end;
        continue;
      }
      const neEnd = namedEntityEnd(s, i);
      if (neEnd > 0) {
        flush();
        nodes.push({ t: 'x', s: s.slice(i, neEnd), raw: s.slice(i, neEnd) });
        i = neEnd;
        continue;
      }
      buf += '&';
      i++;
      continue;
    }
    if (code === 91 || (code === 33 && i + 1 < n && s.charCodeAt(i + 1) === 91)) {
      // Link or image: [text] or ![text], then (dest), [label], [] or nothing.
      const isImg = code === 33;
      const openIdx = isImg ? i + 1 : i;
      const closeIdx = findClosingBracket(s, openIdx);
      if (closeIdx < 0) {
        buf += s[i];
        i++;
        continue;
      }
      const linkText = s.slice(openIdx + 1, closeIdx);
      let href = null;
      let title = null;
      let end = -1;
      const hadParen = closeIdx + 1 < n && s.charCodeAt(closeIdx + 1) === 40;
      if (linkText.indexOf('`') >= 0 && linkTextBadBacktick(linkText)) {
        if (hadParen && suppressDelimsUntil < closeIdx) suppressDelimsUntil = closeIdx;
        buf += s[i];
        i++;
        continue;
      }
      if (hadParen) {
        const dt = parseDestTitle(s, closeIdx + 2);
        if (dt) {
          href = unescapeStr(dt.dest);
          title = dt.title === null ? null : unescapeStr(dt.title);
          end = dt.end;
        }
      }
      if (href === null) {
        let label = null;
        let refEnd = -1;
        if (closeIdx + 1 < n && s.charCodeAt(closeIdx + 1) === 91) {
          const c2 = findClosingBracket(s, closeIdx + 1);
          if (c2 >= 0) {
            label = s.slice(closeIdx + 2, c2);
            refEnd = c2 + 1;
          }
        }
        if (label === null) {
          label = linkText;
          refEnd = closeIdx + 1;
        } else if (label === '') {
          label = linkText;
        }
        const ref = refs.get(normalizeLabel(label));
        if (ref) {
          href = ref.dest;
          title = ref.title;
          end = refEnd;
        }
      }
      if (href === null) {
        // A failed inline [...](...) leaves its bracket span literal for
        // emphasis purposes (but code spans, autolinks and HTML inside
        // still parse). A bare [...], [...][...] or shortcut reference
        // that fails does not suppress.
        if (hadParen && suppressDelimsUntil < closeIdx) suppressDelimsUntil = closeIdx;
        buf += s[i];
        i++;
        continue;
      }
      // A link's text may not itself contain a link (an image is fine).
      // Autolinks (<...>, bare URLs, bare emails) do not count: only a
      // real [...]() or [...][...] link blocks the outer link.
      if (!isImg) {
        const savedLink = inLink;
        inLink = true;
        const inner = scanInline(linkText, refs);
        inLink = savedLink;
        resolveDelims(inner);
        if (nodesHaveLink(inner)) {
          buf += s[i];
          i++;
          continue;
        }
      }
      flush();
      if (isImg) {
        nodes.push({ t: 'img', href: encodeHref(href), alt: escAttr(plainInline(linkText, refs)), title: title === null ? null : escAttr(title) });
      } else {
        nodes.push({ t: 'link', href: encodeHref(href), title: title === null ? null : escAttr(title), text: linkText });
      }
      // A dangling backtick run in the link text pairs in marked's mask
      // with the next same-length run after the link, hiding emphasis
      // delimiters between the link and that run (phantom code span).
      // (No backtick in the text means no dangling run at all.)
      if (linkText.indexOf('`') >= 0) {
        const dl = danglingBacktickLens(linkText);
        for (let q = 0; q < dl.length; q++) {
          const L = dl[q];
          let p = end;
          while (p < n) {
            if (s.charCodeAt(p) === 92) { p += 2; continue; }
            if (s.charCodeAt(p) === 96) {
              let r = 0;
              while (p + r < n && s.charCodeAt(p + r) === 96) r++;
              if (r === L) { if (suppressDelimsUntil < p) suppressDelimsUntil = p; break; }
              p += r;
            } else p++;
          }
        }
      }
      i = end;
      continue;
    }
    if (code === 42 || code === 95) {
      // Emphasis delimiter run.
      const ch = s[i];
      let j = i;
      while (j < n && s.charCodeAt(j) === code) j++;
      if (i < suppressDelimsUntil) {
        buf += s.slice(i, j);
        i = j;
        continue;
      }
      const len = j - i;
      const before = charClass(s, i - 1);
      const after = charClass(s, j);
      // A run can open when it is left-flanking (for *), and for _ also
      // not when it is right-flanking and not preceded by punctuation;
      // it can close when it is right-flanking (for *), and for _ also
      // not when left-flanking and not followed by punctuation.
      const leftFlanking = after !== 0 && !(after === 1 && before !== 0 && before !== 1);
      const rightFlanking = before !== 0 && !(before === 1 && after !== 0 && after !== 1);
      let canOpen;
      let canClose;
      if (code === 42) {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      } else {
        canOpen = leftFlanking && (!rightFlanking || before === 1);
        canClose = rightFlanking && (!leftFlanking || after === 1);
      }
      // A run that can neither open nor close is literal text: it stays
      // in the buffer (so e.g. the _ in a_b@x.y does not break an email).
      if (!canOpen && !canClose) {
        buf += s.slice(i, j);
        i = j;
        continue;
      }
      flush();
      nodes.push({ t: 'd', ch, n: len, o: canOpen, c: canClose });
      i = j;
      continue;
    }
    if (code === 126) {
      // Strikethrough delimiter: runs of exactly 1 or 2 tildes.
      let j = i;
      while (j < n && s.charCodeAt(j) === 126) j++;
      const len = j - i;
      if (len > 2) {
        buf += s.slice(i, j);
        i = j;
        continue;
      }
      const leftFlanking = charClass(s, j) !== 0 && !(charClass(s, j) === 1 && charClass(s, i - 1) !== 0 && charClass(s, i - 1) !== 1);
      const rightFlanking = charClass(s, i - 1) !== 0 && !(charClass(s, i - 1) === 1 && charClass(s, j) !== 0 && charClass(s, j) !== 1);
      if (!leftFlanking && !rightFlanking) {
        buf += s.slice(i, j);
        i = j;
        continue;
      }
      flush();
      nodes.push({ t: 'd', ch: '~', n: len, o: leftFlanking, c: rightFlanking });
      i = j;
      continue;
    }
    if (code === 10) {
      // Soft break, or a hard break when the text run ends in 2+ spaces.
      let k = buf.length;
      while (k > 0 && buf.charCodeAt(k - 1) === 32) k--;
      if (buf.length - k >= 2) {
        buf = buf.slice(0, k);
        flush();
        nodes.push({ t: 'br', hard: true });
        i++;
        // A hard break strips the next line's leading indentation.
        while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
      } else {
        flush();
        nodes.push({ t: 'br', hard: false });
        i++;
      }
      continue;
    }
    if (code === 109 || code === 120) {
      // Scheme autolinks: only mailto: and xmpp: link as a unit, and only
      // when followed by a valid email. mailto: never takes a path; xmpp:
      // takes at most one /segment. Any other scheme leaves the email part
      // to link on its own via the @ branch below.
      let scheme = null;
      if (code === 109 && s.startsWith('mailto:', i)) scheme = 'mailto:';
      else if (code === 120 && s.startsWith('xmpp:', i)) scheme = 'xmpp:';
      if (scheme !== null) {
        let boundary = true;
        if (i > 0) {
          const p = s.charCodeAt(i - 1);
          if (isAlphaNum(p) || p === 95 || p === 47 || p === 46) boundary = false;
        }
        if (boundary) {
          let j = i + scheme.length;
          let ls = j;
          while (ls < n && isEmailLocalChar(s[ls])) ls++;
          if (ls > j && ls < n && s.charCodeAt(ls) === 64) {
            const ds = ls + 1;
            let de = ds;
            while (de < n && (isAlphaNum(s.charCodeAt(de)) || s.charCodeAt(de) === 46 || s.charCodeAt(de) === 45)) de++;
            if (de < n && s.charCodeAt(de) === 95) {
              // followed by _ : no link at all
            } else {
              let dom = s.slice(ds, de);
              while (dom.length > 0 && dom.charCodeAt(dom.length - 1) === 46) {
                dom = dom.slice(0, -1);
                de--;
              }
              if (dom.length > 0 && dom.charCodeAt(dom.length - 1) !== 45 && dom.indexOf('.') >= 0 && isValidDomain(dom)) {
                let end = de;
                if (scheme === 'xmpp:' && de < n && s.charCodeAt(de) === 47) {
                  const ps = de + 1;
                  let pe = ps;
                  while (pe < n && !isSpace(s.charCodeAt(pe)) && s.charCodeAt(pe) !== 60 && s.charCodeAt(pe) !== 47 && s.charCodeAt(pe) !== 63 && s.charCodeAt(pe) !== 35) pe++;
                  const seg = trimExtUrl(s.slice(ps, pe));
                  if (seg.length > 0) end = ps + seg.length;
                }
                const text = s.slice(i, end);
                flush();
                nodes.push({ t: 'link', href: encodeHref(text), title: null, text, plain: true });
                i = end;
                continue;
              }
            }
          }
        }
      }
      buf += s[i];
      i++;
      continue;
    }
    if ((code === 119 || code === 104 || code === 72 || code === 102 || code === 70) && !inLink) {
      // Extended autolinks: www., http://, https://, ftp://. The www.
      // prefix must be lowercase (Www. does not link); the scheme part
      // is case-insensitive (Https:// links too).
      let scheme = null;
      if (code === 119 && s.startsWith('www.', i)) scheme = 'http://';
      else if ((code === 104 || code === 72) && startsWithCI(s, i, 'http://')) scheme = '';
      else if ((code === 104 || code === 72) && startsWithCI(s, i, 'https://')) scheme = '';
      else if ((code === 102 || code === 70) && startsWithCI(s, i, 'ftp://')) scheme = '';
      if (scheme !== null) {
        let boundary = true;
        if (i > 0) {
          const p = s.charCodeAt(i - 1);
          if (isAlphaNum(p) || p === 95 || p === 47 || p === 46) boundary = false;
        }
        if (boundary) {
          let j = i;
          while (j < n && !isSpace(s.charCodeAt(j)) && s.charCodeAt(j) !== 60) j++;
          // A '(' with no ')' after it in the candidate ends the URL
          // (the '(' starts nothing balanced, e.g.
          // https://a.com](https://b.com with no close). A '(' that
          // does have a later ')' stays part of the URL.
          let cand = s.slice(i, j);
          const op = cand.indexOf('(');
          if (op >= 0 && cand.indexOf(')', op) < 0) cand = cand.slice(0, op);
          const url = trimExtUrl(cand);
          if (url.length > 0) {
            const afterScheme = scheme === 'http://' ? url.slice(4) : url.slice(url.indexOf('://') + 3);
            // The domain ends at the first character that cannot be in
            // a domain (alphanumeric, '-', '.', '_'). Trailing URL
            // characters such as ']' or ')' stay in the link text/href
            // (marked links them) but must not poison the domain check.
            let domEnd = afterScheme.length;
            for (let k = 0; k < afterScheme.length; k++) {
              const c = afterScheme.charCodeAt(k);
              if (!isAlphaNum(c) && c !== 45 && c !== 46 && c !== 95) {
                domEnd = k;
                break;
              }
            }
            const dom = afterScheme.slice(0, domEnd);
            // A domain ending in dots is still valid when a path
            // character follows (e.g. https://example.com.\): the
            // dots are part of the domain, not trailing punctuation.
            // Validate the domain with trailing dots removed.
            const domCheck = dom.replace(/\.+$/, '');
            if (isValidDomain(domCheck, true)) {
              flush();
              nodes.push({ t: 'link', href: encodeHref(scheme + url), title: null, text: url, plain: true });
              i += url.length;
              continue;
            }
          }
        }
      }
      buf += s[i];
      i++;
      continue;
    }
    if (code === 64 && !inLink) {
      // Extended email autolink: the local part is the tail of the buffer,
      // starting after the last backslash escape (an escaped char is not
      // part of the email's local part).
      let k = buf.length;
      while (k > 0 && isEmailLocalChar(buf[k - 1])) k--;
      const start = Math.max(k, lastEsc);
      const local = buf.slice(start);
      if (local.length > 0) {
        let j = i + 1;
        while (j < n && (isAlphaNum(s.charCodeAt(j)) || s.charCodeAt(j) === 46 || s.charCodeAt(j) === 45)) j++;
        // A domain followed by _ fails the whole candidate, unless
        // that _ is itself an emphasis delimiter closing an opener
        // already seen (it can open or close), in which case it is not
        // part of the address text. Only a trailing . may be trimmed,
        // and a trailing - fails it.
        if (j < n && s.charCodeAt(j) === 95) {
          const bCls = charClass(s, j - 1);
          const aCls = charClass(s, j + 1);
          const lF = aCls !== 0 && !(aCls === 1 && bCls !== 0 && bCls !== 1);
          const rF = bCls !== 0 && !(bCls === 1 && aCls !== 0 && aCls !== 1);
          const canO = lF && (!rF || bCls === 1);
          const canC = rF && (!lF || aCls === 1);
          let isDelim = false;
          if (canO || canC) {
            for (let q = 0; q < nodes.length; q++) {
              const nd = nodes[q];
              if (nd.t === 'd' && nd.ch === '_' && nd.o && nd.n > 0) { isDelim = true; break; }
            }
          }
          if (!isDelim) {
            buf += '@';
            lastEsc = 0;
            i++;
            continue;
          }
        }
        let dom = s.slice(i + 1, j);
        while (dom.length > 0 && dom.charCodeAt(dom.length - 1) === 46) {
          dom = dom.slice(0, -1);
          j--;
        }
        if (dom.length > 0 && dom.charCodeAt(dom.length - 1) === 45) {
          buf += '@';
          lastEsc = 0;
          i++;
          continue;
        }
        if (dom.indexOf('.') >= 0 && isValidDomain(dom)) {
          const email = local + '@' + dom;
          buf = buf.slice(0, start);
          flush();
          nodes.push({ t: 'link', href: encodeHref('mailto:' + email), title: null, text: email, plain: true });
          i = j;
          continue;
        }
      }
      buf += '@';
      lastEsc = 0;
      i++;
      continue;
    }
    buf += s[i];
    i++;
  }
  flush();
  return nodes;
}

// Plain-text fast path: when a string holds no character that can start
// an inline construct and no autolink starter, its HTML is itself
// (no escaping is needed either, since & < > " ' are all in the set).
// The two-space hard break is the one construct with no trigger char,
// so a "  \n" run also disqualifies it.
const PLAIN_RE = /[*_~`\[\\!<&>"']|www\.|:\/\/|@|mailto:|xmpp:/;
function parseInline(s, refs) {
  if (s.indexOf('  \n') < 0 && !PLAIN_RE.test(s)) return s;
  const nodes = scanInline(s, refs);
  resolveDelims(nodes);
  return emitNodes(nodes, refs);
}

// ---- block parsing ----

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Blank for table bodies: empty or spaces only. A line of only tabs is
// a table row of empty cells, not a blank line.
function isSpacesOnly(line) {
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) !== 32) return false;
  }
  return true;
}

// Visual indent (tab stops of 4) and index of first non-space/tab.
// Most lines start at column 0; they share one result object (callers
// only read it, never write to it), which skips an allocation per line.
const INDENT_ZERO = { indent: 0, idx: 0 };
function indentInfo(line) {
  if (line.length === 0) return INDENT_ZERO;
  const c0 = line.charCodeAt(0);
  if (c0 !== 32 && c0 !== 9) return INDENT_ZERO;
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      col += 4 - (col % 4);
      i++;
    } else break;
  }
  return { indent: col, idx: i };
}

// Remove `n` visual columns from the start of a line. The leading
// whitespace run is expanded to spaces at the line's own tab stops
// first, then `n` columns are dropped, so a tab that follows a removed
// column keeps its original width instead of shrinking.
// Strip `n` columns of leading indentation. A tab starting exactly at
// the boundary is kept whole; a tab straddling the boundary expands
// the whole leading whitespace run to spaces.
function stripCols(line, n) {
  let col = 0;
  let i = 0;
  let straddled = false;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      if (col >= n) break;
      col++;
      i++;
    } else if (c === 9) {
      if (col >= n) break;
      const w = 4 - (col % 4);
      if (col + w <= n) {
        col += w;
        i++;
      } else {
        straddled = true;
        break;
      }
    } else break;
  }
  if (straddled) {
    let total = 0;
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if (c === 32) {
        total++;
        j++;
      } else if (c === 9) {
        total += 4 - (total % 4);
        j++;
      } else break;
    }
    return ' '.repeat(total - n) + line.slice(j);
  }
  return line.slice(i);
}

// Strip `n` columns by first expanding the whole leading whitespace
// run to spaces at its original tab stops, then dropping `n` columns.
// Unlike stripCols this flattens tabs, so a later strip of the result
// composes exactly like one strip of the total (a container strip
// followed by an indented-code strip). Used for list-item content
// lines, where the result is re-parsed as blocks.
function stripColsFlat(line, n) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      col += 4 - (col % 4);
      i++;
    } else break;
  }
  if (col <= n) return line.slice(i);
  return ' '.repeat(col - n) + line.slice(i);
}

// Strip `n` columns of fence indent from a code content line the way
// marked does: each leading whitespace character (space or tab) counts
// as exactly one column, so a tab that starts inside the strip region
// is removed whole and counts as one, never leaving remainder spaces.
// (Unlike stripCols, which expands a straddling tab to its remainder.)
function stripFenceCols(line, n) {
  let i = 0;
  let c = 0;
  while (i < line.length && c < n) {
    const ch = line.charCodeAt(i);
    if (ch === 32 || ch === 9) { i++; c++; }
    else break;
  }
  return line.slice(i);
}

function matchAtx(line, idx) {
  let j = idx;
  while (j < line.length && line.charCodeAt(j) === 35) j++;
  const level = j - idx;
  if (level === 0 || level > 6) return null;
  if (j < line.length && line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 9) return null;
  let content = line.slice(j);
  let s = 0;
  while (s < content.length && (content.charCodeAt(s) === 32 || content.charCodeAt(s) === 9)) s++;
  content = content.slice(s);
  let e = content.length;
  while (e > 0 && (content.charCodeAt(e - 1) === 32 || content.charCodeAt(e - 1) === 9)) e--;
  content = content.slice(0, e);
  let h = content.length;
  while (h > 0 && content.charCodeAt(h - 1) === 35) h--;
  // A closing run of #'s is stripped when it is preceded by a space or
  // when it is the whole content (e.g. "### ###" is an empty heading).
  if (h < content.length && (h === 0 || content.charCodeAt(h - 1) === 32 || content.charCodeAt(h - 1) === 9)) {
    content = content.slice(0, h);
    let e2 = content.length;
    while (e2 > 0 && (content.charCodeAt(e2 - 1) === 32 || content.charCodeAt(e2 - 1) === 9)) e2--;
    content = content.slice(0, e2);
  }
  return { level, text: content };
}

// Setext underline: 1 for '=', 2 for '-', 0 for neither. Indent must be <= 3.
// `info` is a precomputed indentInfo(line), when the caller has one.
function matchSetext(line, info) {
  info = info || indentInfo(line);
  if (info.indent > 3) return 0;
  const c = line.charCodeAt(info.idx);
  if (c !== 61 && c !== 45) return 0;
  // A run of the underline character, then only spaces/tabs. Spaces
  // inside the run (e.g. "= =" or "--- -") disqualify it.
  let k = info.idx;
  while (k < line.length && line.charCodeAt(k) === c) k++;
  for (let q = k; q < line.length; q++) {
    const ch = line.charCodeAt(q);
    if (ch !== 32 && ch !== 9) return 0;
  }
  return c === 61 ? 1 : 2;
}

function isThematicBreak(line, idx) {
  const c = line.charCodeAt(idx);
  if (c !== 42 && c !== 45 && c !== 95) return false;
  let count = 0;
  for (let k = idx; k < line.length; k++) {
    const ch = line.charCodeAt(k);
    if (ch === c) count++;
    else if (ch !== 32 && ch !== 9) return false;
  }
  return count >= 3;
}

function matchFence(line, idx) {
  const c = line.charCodeAt(idx);
  if (c !== 96 && c !== 126) return null;
  let j = idx;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  const len = j - idx;
  if (len < 3) return null;
  const info = line.slice(j);
  if (c === 96 && info.indexOf('`') >= 0) return null;
  return { ch: c, len, info };
}

const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul']);

// HTML block start at line[idx] === '<'. Returns {type, endTag, endMarker} or null.
function htmlBlockStart(line, idx) {
  if (line.charCodeAt(idx) !== 60) return null;
  const c1 = line.charCodeAt(idx + 1);
  if (c1 === 33) {
    if (line.startsWith('<!--', idx)) return { type: 2, endMarker: '-->' };
    if (line.startsWith('<![CDATA[', idx)) return { type: 5, endMarker: ']]>' };
    if (idx + 2 < line.length && isAlphaNum(line.charCodeAt(idx + 2))) return { type: 4, endMarker: '>' };
    return null;
  }
  if (c1 === 63) return { type: 3, endMarker: '?>' };
  let j = idx + 1;
  let closing = false;
  if (line.charCodeAt(j) === 47) {
    closing = true;
    j++;
  }
  let nameEnd = j;
  while (nameEnd < line.length && (isAlphaNum(line.charCodeAt(nameEnd)) || line.charCodeAt(nameEnd) === 45)) nameEnd++;
  const name = line.slice(j, nameEnd).toLowerCase();
  if (name.length === 0) return null;
  // The character after the tag name must be a space, tab, '>', '/' or
  // the end of the line. Types 1 and 6 need only the tag name (and the
  // following separator) on this line; the tag itself may close later.
  const after = nameEnd >= line.length ? -1 : line.charCodeAt(nameEnd);
  if (after !== -1 && after !== 32 && after !== 9 && after !== 62 && after !== 47) return null;
  if (!closing && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) return { type: 1, endTag: name };
  if (BLOCK_TAGS.has(name)) return { type: 6 };
  // Type 7 needs a complete open or closing tag alone on the line.
  const tagEnd = htmlTagEnd(line, idx);
  if (tagEnd < 0) return null;
  let allWs = true;
  for (let k = tagEnd; k < line.length; k++) {
    if (line.charCodeAt(k) !== 32 && line.charCodeAt(k) !== 9) {
      allWs = false;
      break;
    }
  }
  if (allWs) return { type: 7 };
  return null;
}

function matchListMarker(line, idx) {
  const c = line.charCodeAt(idx);
  if (c === 45 || c === 43 || c === 42) {
    const after = idx + 1;
    if (after >= line.length) return { type: 'bullet', bullet: line[idx], markerWidth: 1 };
    const nc = line.charCodeAt(after);
    if (nc === 32 || nc === 9) return { type: 'bullet', bullet: line[idx], markerWidth: 1 };
    return null;
  }
  if (isDigit(c)) {
    let j = idx;
    while (j < line.length && isDigit(line.charCodeAt(j))) j++;
    if (j - idx > 9) return null;
    if (j < line.length && (line.charCodeAt(j) === 46 || line.charCodeAt(j) === 41)) {
      const after = j + 1;
      if (after >= line.length) return { type: 'ordered', delim: line[j], start: parseInt(line.slice(idx, j), 10), markerWidth: j + 1 - idx };
      const nc = line.charCodeAt(after);
      if (nc === 32 || nc === 9) return { type: 'ordered', delim: line[j], start: parseInt(line.slice(idx, j), 10), markerWidth: j + 1 - idx };
    }
    return null;
  }
  return null;
}

// Content indent and first-line content for a list item marker. `indent`
// is the visual indent of the marker itself.
function listContentInfo(line, idx, lm, indent) {
  const markerCol = indent + lm.markerWidth;
  const markerEnd = idx + lm.markerWidth;
  if (markerEnd >= line.length) return { contentIndent: markerCol + 1, firstContent: '', empty: true };
  let col = markerCol;
  let p = markerEnd;
  let spaces = 0;
  while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) {
    if (line.charCodeAt(p) === 32) {
      spaces++;
      col++;
      p++;
    } else {
      const w = 4 - (col % 4);
      spaces += w;
      col += w;
      p++;
    }
  }
  if (p >= line.length) return { contentIndent: markerCol + 1, firstContent: '', empty: true };
  if (spaces >= 1 && spaces <= 4) return { contentIndent: col, firstContent: line.slice(p), empty: false };
  if (spaces === 0) return { contentIndent: markerCol + 1, firstContent: line.slice(markerEnd), empty: false };
  // Five or more columns of whitespace: the content indent is one column
  // past the marker, and the content keeps the remaining whitespace with
  // tabs expanded to spaces at their original positions. (Stripping
  // columns from the raw line would stop at the marker itself and return
  // the whole line, which recurses forever.)
  return { contentIndent: markerCol + 1, firstContent: ' '.repeat(spaces - 1) + line.slice(p), empty: false };
}

// An ordered list marker can interrupt a paragraph only when it starts
// with 1 — except inside a list item, where any start number interrupts
// the item's paragraph (the marker starts a nested list).
function canInterruptParagraph(line, idx, lm, inListItem) {
  const info = indentInfo(line);
  const ci = listContentInfo(line, idx, lm, info.indent);
  if (ci.empty) return false;
  if (lm.type === 'ordered' && lm.start !== 1 && !inListItem) return false;
  return true;
}

// Does this line start a block that can interrupt a paragraph?
// `info` is a precomputed indentInfo(line), when the caller has one.
function interruptsPara(line, inListItem, info) {
  info = info || indentInfo(line);
  if (info.indent > 3) return false;
  const idx = info.idx;
  if (matchAtx(line, idx)) return true;
  if (matchFence(line, idx)) return true;
  const hb = htmlBlockStart(line, idx);
  if (hb && hb.type <= 6) return true;
  if (isThematicBreak(line, idx)) return true;
  if (line.charCodeAt(idx) === 62) return true;
  const lm = matchListMarker(line, idx);
  if (lm && canInterruptParagraph(line, idx, lm, inListItem)) return true;
  return false;
}

// The line after a '>' marker at `idx` (indent `indent`), plus exactly
// one following whitespace column.
function afterQuoteMarker(line, idx, indent) {
  const r = advanceCols(line, idx + 1, indent + 1, 1);
  return r.line.slice(r.pos);
}

// For a line already stripped of its own container's marker, work out
// whether a paragraph is open after it and which container markers a
// lazy continuation line needs to reach that paragraph. Returns
// {inPara, prefix}. A paragraph open inside nested quotes or list items
// is reported with the markers down to it, so a lazy line can be
// re-prefixed and join the innermost paragraph instead of ending the
// container.
function paraPrefixOf(line, inPara) {
  let prefix = '';
  let cur = line;
  let curInPara = inPara;
  for (;;) {
    if (isBlank(cur)) return { inPara: false, prefix: '' };
    const info = indentInfo(cur);
    const idx = info.idx;
    if (info.indent <= 3 && cur.charCodeAt(idx) === 62) {
      prefix += '> ';
      cur = afterQuoteMarker(cur, idx, info.indent);
      continue;
    }
    const lm = info.indent <= 3 ? matchListMarker(cur, idx) : null;
    if (lm) {
      const ci = listContentInfo(cur, idx, lm, info.indent);
      if (ci.empty) return { inPara: false, prefix: '' };
      prefix += ' '.repeat(ci.contentIndent);
      cur = ci.firstContent;
      continue;
    }
    if (matchSetext(cur)) {
      // A setext line converts an open paragraph; on its own it is a
      // paragraph line.
      return curInPara ? { inPara: false, prefix: '' } : { inPara: true, prefix };
    }
    // Indented 4+ with no paragraph open is an indented code block.
    if (info.indent >= 4 && !curInPara) return { inPara: false, prefix: '' };
    if (info.indent <= 3 && (matchAtx(cur, idx) || matchFence(cur, idx) || isThematicBreak(cur, idx))) {
      return { inPara: false, prefix: '' };
    }
    if (info.indent <= 3) {
      const hb = htmlBlockStart(cur, idx);
      if (hb && hb.type <= 6) return { inPara: false, prefix: '' };
    }
    return { inPara: true, prefix };
  }
}

// Split a table row line into cells, respecting \| escapes and code spans.
// Strides between separators with indexOf instead of stepping per character.
function splitTableRow(line) {
  let start = 0;
  while (start < line.length && line.charCodeAt(start) === 32) start++;
  if (line.charCodeAt(start) === 124) start++;
  let end = line.length;
  while (end > start && line.charCodeAt(end - 1) === 32) end--;
  if (end > start && line.charCodeAt(end - 1) === 124) {
    let bs = 0;
    let k = end - 2;
    while (k >= start && line.charCodeAt(k) === 92) {
      bs++;
      k--;
    }
    if (bs % 2 === 0) end--;
  }
  const cells = [];
  let cur = '';
  let i = start;
  let segStart = start;
  while (i < end) {
    // Nearest pipe or backslash from here (both are -1 when absent).
    let pipe = line.indexOf('|', i);
    if (pipe < 0 || pipe >= end) pipe = -1;
    let bs = line.indexOf('\\', i);
    if (bs < 0 || bs >= end) bs = -1;
    if (pipe < 0 && bs < 0) {
      cur += line.slice(segStart, end);
      break;
    }
    if (bs >= 0 && (pipe < 0 || bs < pipe)) {
      cur += line.slice(segStart, bs);
      if (bs + 1 < end) {
        // In tables \| is an escaped pipe: the backslash is dropped.
        if (line.charCodeAt(bs + 1) === 124) cur += '|';
        else cur += line[bs] + line[bs + 1];
        i = bs + 2;
      } else {
        cur += line[bs];
        i = bs + 1;
      }
      segStart = i;
      continue;
    }
    // An unescaped | is always a cell separator, even inside backticks:
    // marked does not let a code span protect a pipe in a table row.
    cur += line.slice(segStart, pipe);
    cells.push(cur);
    cur = '';
    i = pipe + 1;
    segStart = i;
  }
  cells.push(cur);
  for (let t = 0; t < cells.length; t++) {
    const cell = cells[t];
    let a = 0;
    let b = cell.length;
    while (a < b && (cell.charCodeAt(a) === 32 || cell.charCodeAt(a) === 9)) a++;
    while (b > a && (cell.charCodeAt(b - 1) === 32 || cell.charCodeAt(b - 1) === 9)) b--;
    cells[t] = cell.slice(a, b);
  }
  return cells;
}

// Alignment array (null | 'left' | 'right' | 'center') or null if the line
// is not a table delimiter row. The row must be indented at most 3
// columns, and it must contain a pipe or a colon: a bare run of dashes
// with neither is a setext underline or a thematic break, not a delimiter.
// `info` is a precomputed indentInfo(line), when the caller has one.
function delimiterRow(line, info) {
  info = info || indentInfo(line);
  if (info.indent > 3) return null;
  if (line.indexOf('|') < 0 && line.indexOf(':') < 0) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    let a = 0;
    let b = cell.length;
    const left = cell.charCodeAt(0) === 58;
    const right = cell.charCodeAt(cell.length - 1) === 58;
    if (left) a++;
    if (right) b--;
    if (b - a < 1) return null;
    for (let k = a; k < b; k++) {
      if (cell.charCodeAt(k) !== 45) return null;
    }
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

// Code block content: lines joined by newlines, with a final newline,
// except that one trailing blank line's newline is dropped (the closing
// fence's line end is not part of the content).
function codeText(lines) {
  if (lines.length === 0) return '';
  let t = lines.join('\n') + '\n';
  if (lines[lines.length - 1] === '') t = t.slice(0, -1);
  return t;
}

// Parse (dest title) for a link reference definition in `text` at `pos`.
// Returns {dest, title, endPos} or null. Destinations are unescaped
// (backslash escapes only); entities stay verbatim.
function parseDefDestTitle(text, pos) {
  const n = text.length;
  let i = pos;
  while (i < n && isSpace(text.charCodeAt(i))) i++;
  if (i >= n) return null;
  let dest = '';
  if (text.charCodeAt(i) === 60) {
    let j = i + 1;
    while (j < n && text.charCodeAt(j) !== 62 && text.charCodeAt(j) !== 10 && text.charCodeAt(j) !== 60) j++;
    if (j >= n || text.charCodeAt(j) !== 62) return null;
    dest = text.slice(i + 1, j);
    i = j + 1;
  } else {
    let depth = 0;
    let j = i;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (isSpace(c) || c < 32) break;
      if (c === 92) {
        j += 2;
        continue;
      }
      if (c === 40) {
        depth++;
        j++;
        continue;
      }
      if (c === 41) {
        if (depth === 0) break;
        depth--;
        j++;
        continue;
      }
      j++;
    }
    dest = text.slice(i, j);
    i = j;
    if (dest === '') return null;
  }
  dest = unescapeStr(dest);
  // After the destination, a title may follow on the same line (after
  // spaces/tabs) or on the immediately following line. A title on the
  // same line must be followed by only spaces/tabs to the end of the
  // line; junk after it invalidates the whole definition. A title
  // attempted on the next line that fails (unterminated, or followed by
  // junk) is simply ignored and the definition ends after the
  // destination line. A title needs whitespace separating it from the
  // destination: "<bar>(baz)" is not a definition.
  let k = i;
  while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
  if (k === i && k < n && text.charCodeAt(k) !== 10) return null;
  if (k < n && (text.charCodeAt(k) === 34 || text.charCodeAt(k) === 39 || text.charCodeAt(k) === 40)) {
    const r = parseTitleAt(text, k);
    if (!r) return null;
    let e = r.end;
    while (e < n && (text.charCodeAt(e) === 32 || text.charCodeAt(e) === 9)) e++;
    if (e < n && text.charCodeAt(e) !== 10) return null;
    return { dest, title: r.title, endPos: e };
  }
  if (k < n && text.charCodeAt(k) === 10) {
    let k2 = k + 1;
    while (k2 < n && (text.charCodeAt(k2) === 32 || text.charCodeAt(k2) === 9)) k2++;
    if (k2 < n && (text.charCodeAt(k2) === 34 || text.charCodeAt(k2) === 39 || text.charCodeAt(k2) === 40)) {
      const r = parseTitleAt(text, k2);
      if (r) {
        let e = r.end;
        while (e < n && (text.charCodeAt(e) === 32 || text.charCodeAt(e) === 9)) e++;
        if (e >= n || text.charCodeAt(e) === 10) return { dest, title: r.title, endPos: e };
      }
    }
    return { dest, title: null, endPos: k };
  }
  if (k >= n) return { dest, title: null, endPos: k };
  return null;
}

// Parse a "title", 'title' or (title) starting at `k` in `text`.
// Returns {title, end} with `end` just past the closing quote, or null
// when the title is unterminated. Parenthesised titles run to the first
// closing parenthesis. A title may span lines but not a blank line.
function parseTitleAt(text, k) {
  const n = text.length;
  const q = text.charCodeAt(k);
  const close = q === 40 ? 41 : q;
  let j = k + 1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 92 && j + 1 < n && isAsciiPunct(text.charCodeAt(j + 1))) {
      j += 2;
      continue;
    }
    if (c === 10) {
      // A blank line inside the title invalidates it.
      let m = j + 1;
      while (m < n && (text.charCodeAt(m) === 32 || text.charCodeAt(m) === 9)) m++;
      if (m >= n || text.charCodeAt(m) === 10) return null;
    }
    if (c === close) return { title: unescapeStr(text.slice(k + 1, j)), end: j + 1 };
    j++;
  }
  return null;
}

// Try to parse link reference definitions starting at lines[i]. Returns
// the number of lines consumed (0 when the line is not a definition).
// The first definition of a label wins.
function tryParseDefs(lines, i, i1, refs) {
  let idx = i;
  let consumed = 0;
  while (idx < i1) {
    const line = lines[idx];
    const info = indentInfo(line);
    if (info.indent > 3) break;
    const p = info.idx;
    if (line.charCodeAt(p) !== 91) break;
    // The label may span lines, so search the joined text, not the
    // single line. A blank line inside the label, or between the label
    // and the destination/title, disqualifies the definition.
    let blankIdx = i1;
    for (let b = idx + 1; b < i1; b++) {
      if (isBlank(lines[b])) { blankIdx = b; break; }
    }
    const rest = lines.slice(idx, blankIdx).join('\n');
    const close = findClosingBracket(rest, p);
    if (close < 0) break;
    const labelRaw = rest.slice(p + 1, close);
    if (labelRaw.length === 0 || labelRaw.length > 999) break;
    const labelParts = labelRaw.split('\n');
    let blankInside = false;
    for (let q = 1; q < labelParts.length - 1; q++) {
      if (labelParts[q].trim() === '') { blankInside = true; break; }
    }
    if (blankInside) break;
    if (rest.charCodeAt(close + 1) !== 58) break;
    const def = parseDefDestTitle(rest, close + 2);
    if (!def) break;
    let nlCount = 0;
    for (let k = 0; k < def.endPos; k++) {
      if (rest.charCodeAt(k) === 10) nlCount++;
    }
    const linesConsumed = nlCount + 1;
    const label = normalizeLabel(labelRaw);
    if (label === null) break;
    if (!refs.has(label)) refs.set(label, { dest: def.dest, title: def.title });
    idx += linesConsumed;
    consumed += linesConsumed;
  }
  return consumed;
}

// Collect an HTML block starting at lines[i]. Returns {text, end}.
// The text is the block's lines joined by newlines, plus a final newline
// unless the block ended at a blank line, or it is the last block of the
// input and the input had no final newline.
function parseHtmlBlock(lines, i, i1, ctx, hb) {
  let j = i;
  let endsAtBlank = false;
  if (hb.type === 1) {
    const endRe = '</' + hb.endTag;
    while (j < i1) {
      const lower = lines[j].toLowerCase();
      const pos = lower.indexOf(endRe);
      if (pos >= 0) {
        const after = lower[pos + endRe.length];
        if (after === '>' || after === ' ' || after === '\t' || after === undefined) {
          j++;
          break;
        }
      }
      j++;
    }
  } else if (hb.type === 2 || hb.type === 3 || hb.type === 5) {
    while (j < i1) {
      if (lines[j].indexOf(hb.endMarker) >= 0) {
        j++;
        break;
      }
      j++;
    }
  } else if (hb.type === 4) {
    while (j < i1) {
      if (lines[j].indexOf('>') >= 0) {
        j++;
        break;
      }
      j++;
    }
  } else {
    j = i;
    while (j < i1 && !isBlank(lines[j])) j++;
    endsAtBlank = j < i1;
  }
  let text = lines.slice(i, j).join('\n');
  // A trailing newline is added only when the next line in the same
  // container is not empty. A spaces-only or tab-only line counts as
  // content here (it is not empty), so a newline follows it; a truly
  // empty line does not get one. But a type 6/7 block ends AT a blank
  // line, so that blank line never earns a newline.
  if (j < i1 && !endsAtBlank && lines[j].length > 0) text += '\n';
  else if (j >= i1 && ctx.tailNL) text += '\n';
  return { text, end: j };
}

// Collect a block quote starting at lines[i]. Returns {node, end}.
function collectBlockquote(lines, i, i1, ctx) {
  const sub = [];
  const lazy = new Set();
  const noTable = new Set();
  let inPara = false;
  let paraPrefix = '';
  let prevLazy = false;
  // Open fenced code block inside this quote, if any. While set, the
  // lines are code: paraPrefixOf must not read them as quote/list/
  // paragraph text, and a line without '>' ends the quote.
  let fence = null;
  let j = i;
  while (j < i1) {
    const line = lines[j];
    const info = indentInfo(line);
    if (info.indent <= 3 && line.charCodeAt(info.idx) === 62) {
      // Strip '>' and exactly one following column of whitespace. A
      // tab after '>' expands at its original column, so the remainder
      // keeps width minus one (" >\t\tfoo" becomes code " foo").
      const base = info.idx + 1;
      let col = info.indent + 1;
      let q = base;
      let spaces = 0;
      while (q < line.length && (line.charCodeAt(q) === 32 || line.charCodeAt(q) === 9)) {
        if (line.charCodeAt(q) === 32) {
          spaces++;
          col++;
          q++;
        } else {
          const w = 4 - (col % 4);
          spaces += w;
          col += w;
          q++;
        }
      }
      const stripped = spaces === 0 ? line.slice(base) : ' '.repeat(spaces - 1) + line.slice(q);
      if (fence) {
        const sInfo = indentInfo(stripped);
        const fm = sInfo.indent <= 3 ? matchFence(stripped, sInfo.idx) : null;
        if (fm && fm.ch === fence.ch && fm.len >= fence.len && /^[ \t]*$/.test(fm.info)) fence = null;
        sub.push(stripped);
        inPara = false;
        paraPrefix = '';
        prevLazy = false;
        j++;
        continue;
      }
      const sInfo = indentInfo(stripped);
      const fm = sInfo.indent <= 3 ? matchFence(stripped, sInfo.idx) : null;
      if (fm) {
        fence = { ch: fm.ch, len: fm.len };
        sub.push(stripped);
        inPara = false;
        paraPrefix = '';
        prevLazy = false;
        j++;
        continue;
      }
      sub.push(stripped);
      const pp = paraPrefixOf(stripped, inPara);
      inPara = pp.inPara;
      paraPrefix = pp.prefix;
      prevLazy = false;
      j++;
      continue;
    }
    // A blank line without '>' ends the quote.
    if (isBlank(line)) break;
    if (inPara) {
      // A lazy line that starts a list (any start number) ends the
      // quote: the list starts fresh outside it, so the start-with-1
      // paragraph-interruption rule does not apply here.
      const linfo = indentInfo(line);
      if (linfo.indent <= 3 && matchListMarker(line, linfo.idx)) break;
      if (interruptsPara(line, undefined, linfo)) break;
      const st = matchSetext(line, linfo);
      if (st !== 0) {
        // A lazy setext underline stays paragraph text. After another
        // lazy line it is indented 4 spaces so it is not read as an
        // underline; otherwise it is kept as-is and flagged so the
        // paragraph parser does not convert it.
        if (prevLazy) {
          let s = 0;
          while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
          lazy.add(sub.length);
          sub.push('    ' + line.slice(s));
        } else {
          lazy.add(sub.length);
          sub.push(line);
        }
        prevLazy = true;
        j++;
        continue;
      }
      const aligns = delimiterRow(line, linfo);
      if (aligns) {
        // A lazy delimiter row makes a table only when the previous
        // line was lazy too; otherwise it stays paragraph text.
        if (!prevLazy) noTable.add(sub.length);
        lazy.add(sub.length);
        sub.push(line);
        prevLazy = true;
        j++;
        continue;
      }
      lazy.add(sub.length);
      // A lazy continuation line is stripped by up to four columns and
      // re-prefixed with the markers of the innermost open paragraph.
      // With no nested prefix (a plain top-level quote), only a line
      // indented four or more columns loses four columns; fewer than
      // four are paragraph text and are kept verbatim.
      sub.push(paraPrefix === '' ? (info.indent >= 4 ? stripCols(line, 4) : line) : paraPrefix + stripCols(line, Math.min(info.indent, 4)));
      prevLazy = true;
      j++;
      continue;
    }
    break;
  }
  let end = sub.length;
  while (end > 0 && sub[end - 1] === '') end--;
  const trimmed = sub.slice(0, end);
  const lazyT = new Set();
  for (const x of lazy) if (x < end) lazyT.add(x);
  const noTableT = new Set();
  for (const x of noTable) if (x < end) noTableT.add(x);
  const children = parseBlocks(trimmed, 0, trimmed.length, { refs: ctx.refs, tailNL: false, lazy: lazyT, noTable: noTableT, nested: true });
  return { node: { t: 'quote', children }, end: j };
}

// Collect a list starting at lines[i]. Returns {node, end}.
function parseList(lines, i, i1, ctx) {
  const first = lines[i];
  const info0 = indentInfo(first);
  const lm0 = matchListMarker(first, info0.idx);
  const ordered = lm0.type === 'ordered';
  const bullet = ordered ? null : lm0.bullet;
  const delim = ordered ? lm0.delim : null;
  const start = ordered ? lm0.start : 1;
  const items = [];
  let loose = false;
  let j = i;
  while (j < i1) {
    const line = lines[j];
    const info = indentInfo(line);
    if (info.indent > 3) break;
    // A thematic break ends the list and starts a new block.
    if (isThematicBreak(line, info.idx)) break;
    const lm = matchListMarker(line, info.idx);
    if (!lm) break;
    if (ordered !== (lm.type === 'ordered')) break;
    if (!ordered && lm.bullet !== bullet) break;
    if (ordered && lm.delim !== delim) break;
    const ci = listContentInfo(line, info.idx, lm, info.indent);
    const itemLines = [ci.firstContent];
    const lazy = new Set();
    let inPara = false;
    let paraPrefix = '';
    // Indent (in source coordinates) of the most recent nested list
    // marker seen in this item; -1 when not inside a nested list.
    // Lines inside a nested list never take the +4 paragraph strip:
    // that strip belongs to this item's own paragraph, and the nested
    // list's own parser handles its content indent.
    let nestedIndent = -1;
    // Open fenced code block inside this item, if any. While set, the
    // lines are code: they take the content-indent strip only and never
    // count as paragraph text (paraPrefixOf cannot see fences).
    let fence = null;
    // itemLines length right after the fence opener is pushed; a
    // below-indent line while the fence has no content yet ends the
    // fence (empty) and the item, but once content exists the line is
    // still code.
    let fenceStartLen = -1;
    if (!ci.empty) {
      const pp = paraPrefixOf(ci.firstContent, false);
      inPara = pp.inPara;
      paraPrefix = pp.prefix;
    }
    let k = j + 1;
    while (k < i1) {
      const l2 = lines[k];
      if (isBlank(l2)) {
        let m = k + 1;
        while (m < i1 && isBlank(lines[m])) m++;
        if (m >= i1) {
          for (let b = k; b < m; b++) itemLines.push('');
          k = m;
          break;
        }
        const nl = lines[m];
        const ninfo = indentInfo(nl);
        const nlm = ninfo.indent <= 3 ? matchListMarker(nl, ninfo.idx) : null;
        // A marker after a blank line is the next item of this list —
        // unless the current item already holds a nested list whose
        // markers sit at this same indent (in itemLines coordinates).
        // Then the marker continues that nested list, and the blank
        // line must not mark this list loose. Sibling markers may sit
        // up to 3 columns from the first marker's indent (cm-311), so
        // indent equality with the first marker is not the test.
        let isNextItem = !!nlm && ((ordered && nlm.type === 'ordered' && nlm.delim === delim) || (!ordered && nlm.type === 'bullet' && nlm.bullet === bullet));
        if (isNextItem) {
          const candIndent = ninfo.indent - ci.contentIndent;
          for (const il of itemLines) {
            if (il === '') continue;
            const ii = indentInfo(il);
            if (ii.indent === candIndent && ii.indent <= 3 && matchListMarker(il, ii.idx)) { isNextItem = false; break; }
          }
        }
        // Blank lines inside a fenced code block are code, not item
        // separators: the fence continues regardless of what follows.
        const belongs = fence ? true : ninfo.indent >= ci.contentIndent;
        // A blank line before the next item makes the list loose.
        if (isNextItem) loose = true;
        // An empty item cannot claim lines after a blank line, but a
        // following item still continues the list.
        let itemEmpty = true;
        for (let b = 0; b < itemLines.length; b++) {
          if (itemLines[b] !== '') { itemEmpty = false; break; }
        }
        if (isNextItem || (belongs && !itemEmpty)) {
          for (let b = k; b < m; b++) itemLines.push('');
          k = m;
          inPara = false;
          paraPrefix = '';
          continue;
        }
        break;
      }
      const i2 = indentInfo(l2);
      if (i2.indent >= ci.contentIndent) {
        // Inside a fenced code block the line is code: strip the
        // content indent only, never the paragraph extra four, and do
        // not let paraPrefixOf read code as quote/list/paragraph text.
        const strippedCI = stripColsFlat(l2, ci.contentIndent);
        if (fence) {
          const sInfo = indentInfo(strippedCI);
          const fm = sInfo.indent <= 3 ? matchFence(strippedCI, sInfo.idx) : null;
          if (fm && fm.ch === fence.ch && fm.len >= fence.len && /^[ \t]*$/.test(fm.info)) fence = null;
          itemLines.push(strippedCI);
          inPara = false;
          paraPrefix = '';
          k++;
          continue;
        }
        const sInfo = indentInfo(strippedCI);
        const fm = sInfo.indent <= 3 ? matchFence(strippedCI, sInfo.idx) : null;
        if (fm) {
          fence = { ch: fm.ch, len: fm.len };
          itemLines.push(strippedCI);
          fenceStartLen = itemLines.length;
          inPara = false;
          paraPrefix = '';
          k++;
          continue;
        }
        // A paragraph continuation line is stripped by the content
        // indent plus four more columns when its indent reaches that
        // far (the extra four are the indented-code margin, which a
        // paragraph continuation absorbs as text); any other line is
        // stripped by the content indent only and re-parsed as a block.
        // A list marker line starts a nested list, never a paragraph
        // continuation, so it never takes the extra four columns. The
        // extra four also never apply inside a nested container: a
        // paragraph open only inside a nested list/quote is not this
        // item's own paragraph (paraPrefix non-empty), and a line
        // inside a nested list (nestedIndent set) is the nested
        // list's own content.
        const isMarker = matchListMarker(l2, i2.idx) !== null;
        if (isMarker) nestedIndent = i2.indent;
        else if (nestedIndent >= 0 && i2.indent < nestedIndent) nestedIndent = -1;
        // The +4 threshold uses the leading-whitespace character count
        // (i2.idx), not the column indent: a tab counts as one here, so
        // a tab-indented line does not spuriously reach the threshold
        // and lose its following spaces (doc-28: `\t  "key"` keeps 2).
        const stripN = inPara && paraPrefix === '' && nestedIndent < 0 && !isMarker && i2.idx >= ci.contentIndent + 4 ? ci.contentIndent + 4 : ci.contentIndent;
        const stripped = stripN === ci.contentIndent ? strippedCI : stripColsFlat(l2, stripN);
        itemLines.push(stripped);
        const pp = paraPrefixOf(stripped, inPara);
        inPara = pp.inPara;
        paraPrefix = pp.prefix;
        // A nested list marker starts a new block, not a continuation
        // of this item's paragraph. paraPrefixOf descends into the
        // marker and reports the nested item's paragraph as open, but
        // for this item's strip decision that must not count: the next
        // line belongs to the nested list and must be stripped by the
        // content indent only, not content indent + 4.
        {
          const sInfo = indentInfo(stripped);
          if (sInfo.indent <= 3 && matchListMarker(stripped, sInfo.idx)) inPara = false;
        }
        k++;
        continue;
      }
      const lm2 = i2.indent <= 3 ? matchListMarker(l2, i2.idx) : null;
      if (lm2) break;
      if (interruptsPara(l2, false, i2)) break;
      if (fence) {
        // A non-blank fence line below the content indent ends the
        // item only while the fence has no content yet (it stays
        // empty); once content exists the line is still code.
        if (itemLines.length === fenceStartLen) break;
        const codeLine = stripCols(l2, Math.min(i2.indent, ci.contentIndent));
        const cInfo = indentInfo(codeLine);
        const cfm = cInfo.indent <= 3 ? matchFence(codeLine, cInfo.idx) : null;
        if (cfm && cfm.ch === fence.ch && cfm.len >= fence.len && /^[ \t]*$/.test(cfm.info)) fence = null;
        itemLines.push(codeLine);
        inPara = false;
        paraPrefix = '';
        k++;
        continue;
      }
      if (inPara) {
        // A lazy line joins the paragraph re-prefixed with the
        // markers of the innermost open paragraph. Its leading spaces
        // are paragraph text when the indent is below 4 (a space
        // between words), so they are kept. At indent 4 or more the
        // spaces are structural indentation and are stripped up to
        // the content indent (cm-291, cm-312).
        lazy.add(itemLines.length);
        const strip = i2.indent >= 4 ? Math.min(i2.indent, ci.contentIndent) : 0;
        itemLines.push(paraPrefix + stripCols(l2, strip));
        k++;
        continue;
      }
      break;
    }
    let endIdx = itemLines.length;
    while (endIdx > 0 && itemLines[endIdx - 1] === '') endIdx--;
    const hasTrailingBlanks = endIdx < itemLines.length;
    const trimmed = itemLines.slice(0, endIdx);
    const lazyT = new Set();
    for (const x of lazy) if (x < endIdx) lazyT.add(x);
    items.push({ lines: trimmed, hasTrailingBlanks, lazy: lazyT });
    j = k;
    if (j >= i1) break;
    const nline = lines[j];
    const ninfo = indentInfo(nline);
    if (ninfo.indent > 3) break;
    if (isThematicBreak(nline, ninfo.idx)) break;
    const nlm = matchListMarker(nline, ninfo.idx);
    if (!nlm) break;
    if (ordered !== (nlm.type === 'ordered')) break;
    if (!ordered && nlm.bullet !== bullet) break;
    if (ordered && nlm.delim !== delim) break;
    if (hasTrailingBlanks && trimmed.length > 0) loose = true;
  }
  const parsedItems = items.map((it) => {
    const blocks = it.lines.length === 0 ? [] : parseBlocks(it.lines, 0, it.lines.length, { refs: ctx.refs, tailNL: false, lazy: it.lazy, nested: true, inListItem: true });
    if (blocks.length > 0 && blocks[0].t === 'para') {
      const tx = blocks[0].text;
      const m = /^\[([ xX])\][ \t]+(.+)$/s.exec(tx);
      if (m) {
        blocks[0].task = m[1] === ' ' ? ' ' : 'x';
        blocks[0].text = m[2];
      }
    }
    return { blocks };
  });
  // A list is loose if any item's own blocks are separated by a blank
  // line (blank lines inside a nested container do not count).
  for (const it of parsedItems) {
    if (it.blocks.loose) {
      loose = true;
      break;
    }
  }
  return { node: { t: 'list', ordered, start, loose, items: parsedItems }, end: j };
}

// The block parser: walks lines[i0..i1) and returns a list of block nodes.
// Paragraph lines are kept verbatim (marked keeps their leading spaces);
// container prefixes (quote markers, list markers) are stripped by the
// collectors that build the sub-line arrays.
function parseBlocks(lines, i0, i1, ctx) {
  const nodes = [];
  const refs = ctx.refs;
  // Whether a blank line separated two top-level blocks in this
  // container (used for loose/tight list detection).
  let sawBlank = false;
  let loose = false;
  let i = i0;
  while (i < i1) {
    const line = lines[i];
    if (isBlank(line)) {
      sawBlank = true;
      i++;
      continue;
    }
    if (nodes.length > 0 && sawBlank) loose = true;
    sawBlank = false;
    const info = indentInfo(line);
    const ind = info.indent;
    const idx = info.idx;
    if (ind <= 3) {
      if (line.charCodeAt(idx) === 91) {
        const consumed = tryParseDefs(lines, i, i1, refs);
        if (consumed > 0) {
          i += consumed;
          continue;
        }
      }
      const atx = matchAtx(line, idx);
      if (atx) {
        nodes.push({ t: 'head', level: atx.level, text: atx.text });
        i++;
        continue;
      }
      const fence = matchFence(line, idx);
      if (fence) {
        const codeLines = [];
        let j = i + 1;
        while (j < i1) {
          const l2 = lines[j];
          const inf2 = indentInfo(l2);
          if (inf2.indent <= 3) {
            const c2 = l2.charCodeAt(inf2.idx);
            if (c2 === fence.ch) {
              let r = inf2.idx;
              while (r < l2.length && l2.charCodeAt(r) === fence.ch) r++;
              if (r - inf2.idx >= fence.len) {
                let onlyWs = true;
                for (let q = r; q < l2.length; q++) {
                  if (l2.charCodeAt(q) !== 32 && l2.charCodeAt(q) !== 9) {
                    onlyWs = false;
                    break;
                  }
                }
                if (onlyWs) break;
              }
            }
          }
          // A backtick fence strips up to its own indent from content
          // lines; a tilde fence does not strip any indent (marked
          // keeps the content's leading whitespace verbatim).
          codeLines.push(stripFenceCols(l2, fence.ch === 96 ? ind : 0));
          j++;
        }
        const infoStr = fence.info.replace(/^[ \t]+/, '');
        // The language is the info string's first word with backslash
        // escapes processed; it is rendered as an attribute (entities in
        // it are left verbatim, so escAttr is used, not esc).
        const lang = unescapeStr(infoStr.split(/[ \t]/, 1)[0] || '');
        nodes.push({ t: 'code', lang, text: codeText(codeLines) });
        i = j + (j < i1 ? 1 : 0);
        continue;
      }
      const hb = htmlBlockStart(line, idx);
      if (hb) {
        const r = parseHtmlBlock(lines, i, i1, ctx, hb);
        nodes.push({ t: 'html', text: r.text });
        i = r.end;
        continue;
      }
      if (isThematicBreak(line, idx)) {
        nodes.push({ t: 'hr' });
        i++;
        continue;
      }
      if (line.charCodeAt(idx) === 62) {
        const r = collectBlockquote(lines, i, i1, ctx);
        nodes.push(r.node);
        i = r.end;
        continue;
      }
      const lm = matchListMarker(line, idx);
      if (lm) {
        const r = parseList(lines, i, i1, ctx);
        nodes.push(r.node);
        i = r.end;
        continue;
      }
    }
    if (ind >= 4) {
      const codeLines = [];
      let j = i;
      while (j < i1) {
        const l2 = lines[j];
        if (isBlank(l2)) {
          let m = j + 1;
          while (m < i1 && isBlank(lines[m])) m++;
          if (m < i1 && indentInfo(lines[m]).indent >= 4) {
            // Blank lines inside indented code keep their indent minus
            // 4 columns (a 6-space blank line contributes two spaces).
            for (let b = j; b < m; b++) codeLines.push(stripCols(lines[b], 4));
            j = m;
            continue;
          }
          break;
        }
        const inf2 = indentInfo(l2);
        if (inf2.indent >= 4) {
          codeLines.push(stripCols(l2, 4));
          j++;
          continue;
        }
        break;
      }
      nodes.push({ t: 'code', lang: '', text: codeText(codeLines) });
      i = j;
      continue;
    }
    // Paragraph, with setext headings and tables recognised as its lines arrive.
    // An ordered marker may interrupt a paragraph at any start number
    // only when the paragraph is the list item's own opening paragraph
    // (the one starting on the marker line). A later paragraph inside
    // the same item -- e.g. one after a nested list has ended -- takes
    // the marker as a lazy continuation instead.
    const paraInListItem = ctx.inListItem && i === i0;
    const paraLines = [line];
    let j = i + 1;
    let done = false;
    while (j < i1) {
      const l2 = lines[j];
      if (isBlank(l2)) {
        // A whitespace-only line that ends a nested container's content
        // joins the open paragraph (its spaces are kept).
        if (ctx.nested && j === i1 - 1 && l2.length > 0) {
          paraLines.push(l2);
          j++;
        }
        break;
      }
      const info2 = indentInfo(l2);
      const st = matchSetext(l2, info2);
      // A lazy setext underline (one added without its container
      // prefix) never converts the paragraph; it stays text.
      if (st && !(ctx.lazy && ctx.lazy.has(j))) {
        const defLines = paraLines.slice();
        const consumed = tryParseDefs(defLines, 0, defLines.length, refs);
        const rest = defLines.slice(consumed);
        if (rest.length > 0) {
          // The heading covers the paragraph from its first lazy line;
          // earlier lines are a separate paragraph.
          let split = -1;
          for (let q = 0; q < rest.length; q++) {
            if (ctx.lazy && ctx.lazy.has(i + consumed + q)) { split = q; break; }
          }
          if (split > 0) {
            nodes.push({ t: 'para', text: rest.slice(0, split).join('\n') });
            nodes.push({ t: 'head', level: st, text: rest.slice(split).join('\n').trim() });
          } else {
            nodes.push({ t: 'head', level: st, text: rest.join('\n').trim() });
          }
        } else {
          nodes.push({ t: 'para', text: l2 });
        }
        j++;
        done = true;
        break;
      }
      const aligns = delimiterRow(l2, info2);
      if (aligns && !(ctx.noTable && ctx.noTable.has(j))) {
        // The header is the paragraph's last line; earlier lines are a
        // separate paragraph. Check the column count against the raw
        // last line first so a failed check does not consume defs.
        const rawHeader = splitTableRow(paraLines[paraLines.length - 1]);
        if (rawHeader.length === aligns.length) {
          const defLines = paraLines.slice();
          const consumed = tryParseDefs(defLines, 0, defLines.length, refs);
          const rest = defLines.slice(consumed);
          if (rest.length > 0) {
            if (rest.length > 1) nodes.push({ t: 'para', text: rest.slice(0, -1).join('\n') });
            const header = splitTableRow(rest[rest.length - 1]);
            let k = j + 1;
            const rows = [];
            // A table row is any line that is not empty and not spaces-only:
            // a line of only tabs is a row of empty cells, and a line with
            // no pipes is a single-cell row.
            while (k < i1 && !isSpacesOnly(lines[k])) {
              // A line starting a new block ends the table body.
              if (interruptsPara(lines[k], paraInListItem)) break;
              rows.push(splitTableRow(lines[k]));
              k++;
            }
            nodes.push({ t: 'table', header, aligns, rows });
            j = k;
            done = true;
            break;
          }
        }
      }
      if (info2.indent <= 3) {
        // A lazy line is a paragraph continuation, never a new block.
        if (ctx.lazy && ctx.lazy.has(j)) {
          paraLines.push(l2);
          j++;
          continue;
        }
        const idx2 = info2.idx;
        if (matchAtx(l2, idx2)) break;
        if (matchFence(l2, idx2)) break;
        const hb2 = htmlBlockStart(l2, idx2);
        if (hb2 && hb2.type <= 6) break;
        if (isThematicBreak(l2, idx2)) break;
        if (l2.charCodeAt(idx2) === 62) break;
        const lm2 = matchListMarker(l2, idx2);
        if (lm2 && canInterruptParagraph(l2, idx2, lm2, paraInListItem)) break;
      }
      paraLines.push(l2);
      j++;
    }
    if (!done) nodes.push({ t: 'para', text: paraLines.join('\n') });
    i = j;
  }
  nodes.loose = loose;
  return nodes;
}

// ---- rendering ----

function renderTable(node, refs) {
  const alignAttr = (a) => (a ? ' align="' + a + '"' : '');
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < node.header.length; c++) {
    out += '<th' + alignAttr(node.aligns[c] || null) + '>' + parseInline(node.header[c], refs) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (node.rows.length === 0) {
    out += '</table>\n';
    return out;
  }
  out += '<tbody>';
  for (let r = 0; r < node.rows.length; r++) {
    out += '<tr>\n';
    const row = node.rows[r];
    for (let c = 0; c < node.header.length; c++) {
      const cell = c < row.length ? row[c] : '';
      out += '<td' + alignAttr(node.aligns[c] || null) + '>' + parseInline(cell, refs) + '</td>\n';
    }
    out += '</tr>\n';
  }
  out += '</tbody></table>\n';
  return out;
}

function renderBlocks(nodes, refs, tight) {
  let out = '';
  for (const node of nodes) {
    if (node.t === 'para') {
      const inner = (node.task ? (node.task === 'x' ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ') : '') + parseInline(node.text, refs);
      out += tight ? inner : '<p>' + inner + '</p>\n';
    } else if (node.t === 'head') {
      out += '<h' + node.level + '>' + parseInline(node.text, refs) + '</h' + node.level + '>\n';
    } else if (node.t === 'code') {
      out += '<pre><code' + (node.lang ? ' class="language-' + escAttr(node.lang) + '"' : '') + '>' + esc(node.text) + '</code></pre>\n';
    } else if (node.t === 'html') {
      out += node.text;
    } else if (node.t === 'hr') {
      out += '<hr>\n';
    } else if (node.t === 'quote') {
      out += '<blockquote>\n' + renderBlocks(node.children, refs, false) + '</blockquote>\n';
    } else if (node.t === 'list') {
      let lout = node.ordered ? '<ol' + (node.start !== 1 ? ' start="' + node.start + '"' : '') + '>\n' : '<ul>\n';
      for (const item of node.items) {
        lout += '<li>' + renderBlocks(item.blocks, refs, !node.loose) + '</li>\n';
      }
      lout += node.ordered ? '</ol>\n' : '</ul>\n';
      out += lout;
    } else if (node.t === 'table') {
      out += renderTable(node, refs);
    }
  }
  return out;
}

/** Render markdown to HTML, matching marked 18.1.3 with default options. */
export function parse(markdown) {
  if (markdown === '') return '';
  inLink = false;
  const src = markdown.replace(/\r\n?/g, '\n');
  if (src === '') return '';
  const lines = src.split('\n');
  let tailNL = false;
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
    tailNL = true;
  }
  if (lines.length === 0) return '';
  const refs = new Map();
  const nodes = parseBlocks(lines, 0, lines.length, { refs, tailNL });
  return renderBlocks(nodes, refs, false);
}
