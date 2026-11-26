// Raw leak scan: looks for a string in the BYTES of a PDF rather than in what a text extractor reports.
// It finds text that pdf.js and pdftotext cannot see any more but that is still in the file:
//   - the original content stream left behind as an unreferenced object (no garbage collection),
//   - the superseded revision of an incrementally saved file,
//   - /ActualText, /Alt, /Contents, /V, /T strings (literal or UTF-16BE hex), also inside object streams.
// It is a one-way test: a hit is a leak; no hit proves nothing for text shown through an Identity-H font
// (the stream holds glyph ids, not characters).
// Byte patterns shorter than 6 bytes are not searched (they occur by chance in binary data), so a marker
// needs at least MIN_SCAN_CHARACTERS characters: a shorter one is refused with a RangeError instead of being
// reported as "not found".
//
// Method: every "stream ... endstream" segment is taken as is and, when it inflates, inflated. Text-like
// streams are additionally reduced to the concatenation of their string operands, so that
// "[(MAR) -20 (KER)] TJ" is found as "MARKER". The file bytes outside streams are searched too.
import zlib from 'node:zlib';

const CP1252 = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
  [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91],
  [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98],
  [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

function singleByte(text) {
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp <= 0xff) out.push(cp);
    else if (CP1252.has(cp)) out.push(CP1252.get(cp));
    else return null;
  }
  return Buffer.from(out);
}

function utf16be(text) {
  const out = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i++) out.writeUInt16BE(text.charCodeAt(i), i * 2);
  return out;
}

/** The shortest marker the scan can look for in every encoding. */
export const MIN_SCAN_CHARACTERS = 6;

/** Byte patterns under which `text` can be stored in a PDF. */
export function needles(text) {
  const list = [];
  const add = (kind, bytes) => {
    if (bytes && bytes.length >= 6 && !list.some((n) => n.bytes.equals(bytes))) list.push({ kind, bytes });
  };
  const sb = singleByte(text);
  if (sb) {
    add('single-byte', sb);
    add('single-byte literal-escaped', Buffer.from(sb.toString('latin1').replace(/([\\()])/g, '\\$1'), 'latin1'));
    add('single-byte hex', Buffer.from(sb.toString('hex').toUpperCase(), 'latin1'));
  }
  const u16 = utf16be(text);
  add('utf-16be', u16);
  add('utf-16be hex', Buffer.from(u16.toString('hex').toUpperCase(), 'latin1'));
  add('utf-8', Buffer.from(text, 'utf8'));
  return list;
}

function upperHexAscii(buf) {
  // upper-cases a-f so that lower-case hex strings match the upper-case hex needles
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i++) if (out[i] >= 0x61 && out[i] <= 0x66) out[i] -= 0x20;
  return out;
}

function looksLikeText(buf) {
  const n = Math.min(buf.length, 2048);
  if (n === 0) return false;
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
  }
  return printable / n > 0.85;
}

/** Concatenation of all string operands (literal and hex) of a content-stream-like buffer. */
export function joinStringOperands(buf) {
  const out = [];
  const n = buf.length;
  let i = 0;
  while (i < n) {
    const b = buf[i];
    if (b === 0x25) {
      // comment
      while (i < n && buf[i] !== 10 && buf[i] !== 13) i++;
    } else if (b === 0x28) {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const c = buf[i];
        if (c === 0x5c) {
          const d = buf[i + 1];
          if (d >= 0x30 && d <= 0x37) {
            let v = 0;
            let k = 0;
            while (k < 3 && buf[i + 1 + k] >= 0x30 && buf[i + 1 + k] <= 0x37) {
              v = v * 8 + (buf[i + 1 + k] - 0x30);
              k++;
            }
            out.push(v & 0xff);
            i += 1 + k;
          } else if (d === 13 || d === 10) {
            i += d === 13 && buf[i + 2] === 10 ? 3 : 2;
          } else {
            const map = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
            out.push(map[d] ?? d);
            i += 2;
          }
        } else if (c === 0x28) {
          depth++;
          out.push(c);
          i++;
        } else if (c === 0x29) {
          depth--;
          if (depth > 0) out.push(c);
          i++;
        } else {
          out.push(c);
          i++;
        }
      }
    } else if (b === 0x3c && buf[i + 1] !== 0x3c) {
      i++;
      let hi = -1;
      while (i < n && buf[i] !== 0x3e) {
        const c = buf[i];
        const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
        if (v >= 0) {
          if (hi < 0) hi = v;
          else {
            out.push(hi * 16 + v);
            hi = -1;
          }
        }
        i++;
      }
      if (hi >= 0) out.push(hi * 16);
      i++;
    } else if (b === 0x3c) {
      i += 2;
    } else {
      i++;
    }
  }
  return Buffer.from(out);
}

function stripSpaces(buf) {
  const out = Buffer.alloc(buf.length);
  let n = 0;
  for (const b of buf) if (b !== 0x20 && b !== 9 && b !== 10 && b !== 13 && b !== 0) out[n++] = b;
  return out.subarray(0, n);
}

/** Splits a PDF into its stream segments and the bytes outside them. */
function segments(buf) {
  const streams = [];
  const outside = [];
  let pos = 0;
  for (;;) {
    const s = buf.indexOf('stream', pos, 'latin1');
    if (s < 0) break;
    // must be the keyword that follows a dictionary: next byte is CR or LF, and it is not "endstream"
    const next = buf[s + 6];
    const isEnd = s >= 3 && buf.toString('latin1', s - 3, s) === 'end';
    if (isEnd || (next !== 10 && next !== 13)) {
      pos = s + 6;
      continue;
    }
    let dataStart = s + 6;
    if (buf[dataStart] === 13) dataStart++;
    if (buf[dataStart] === 10) dataStart++;
    const e = buf.indexOf('endstream', dataStart, 'latin1');
    if (e < 0) break;
    outside.push(buf.subarray(pos, s));
    streams.push({ offset: s, data: buf.subarray(dataStart, e) });
    pos = e + 9;
  }
  outside.push(buf.subarray(pos));
  return { streams, outside: Buffer.concat(outside) };
}

function inflate(data) {
  for (let cut = 0; cut <= 2; cut++) {
    try {
      // tolerate the EOL before "endstream" being part of the slice
      return zlib.inflateSync(data.subarray(0, data.length - cut), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {
      /* try again shorter */
    }
  }
  return null;
}

/** Prepares a PDF for repeated searches. */
export function indexPdf(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { streams, outside } = segments(buf);
  const haystacks = [{ where: 'outside streams (dictionaries, strings)', kind: 'dict', data: outside, hex: upperHexAscii(outside) }];
  for (const s of streams) {
    const inflated = inflate(s.data);
    const data = inflated || s.data;
    const text = looksLikeText(data);
    const content = text && /(^|[\s\]>)])(BT|Tj|TJ)(\s|$)/.test(data.toString('latin1', 0, Math.min(data.length, 200000)));
    const objstm = text && /^\s*\d+\s+\d+(\s+\d+\s+\d+)*\s*(<<|\[|\()/.test(data.toString('latin1', 0, 200));
    const kind = content ? 'content' : objstm ? 'objstm' : text ? 'text' : 'binary';
    const where = `stream at byte ${s.offset}${inflated ? ' (inflated)' : ''} [${kind}]`;
    haystacks.push({ where, kind, data, hex: text ? upperHexAscii(data) : null });
    if (text) {
      const joined = joinStringOperands(data);
      if (joined.length) {
        haystacks.push({ where: `${where} string operands joined`, kind, data: joined, hex: null });
        // word gaps made of TJ adjustments leave no space characters: also offer a white-space-free form
        haystacks.push({ where: `${where} string operands joined`, kind, data: stripSpaces(joined), hex: null, squashed: true });
      }
    }
  }
  return { haystacks, streamCount: streams.length };
}

/**
 * Searches one string. Returns the list of hits [{ where, kind, encoding }]; kind is "content" for a stream that
 * holds text operators, "objstm" / "text" / "binary" for other streams and "dict" for bytes outside streams.
 */
export function findInPdf(index, text) {
  if (typeof text !== 'string' || text.length < MIN_SCAN_CHARACTERS) {
    throw new RangeError(`rawScan: a marker needs at least ${MIN_SCAN_CHARACTERS} characters (got ${JSON.stringify(text)}); shorter byte patterns are never searched`);
  }
  const hits = [];
  const seen = new Set();
  for (const nd of needles(text)) {
    const isHex = nd.kind.endsWith('hex');
    for (const h of index.haystacks) {
      if (h.squashed && nd.kind !== 'single-byte') continue;
      const hay = isHex ? h.hex : h.data;
      if (!hay) continue;
      const needle = h.squashed ? stripSpaces(nd.bytes) : nd.bytes;
      if (needle.length >= 6 && hay.indexOf(needle) >= 0) {
        const base = h.where.replace(' string operands joined', '');
        if (seen.has(base)) continue;
        seen.add(base);
        hits.push({ where: h.where, kind: h.kind, encoding: nd.kind });
      }
    }
  }
  return hits;
}

export function rawScan(bytes, texts) {
  const index = indexPdf(bytes);
  return Object.fromEntries(texts.map((t) => [t, findInPdf(index, t)]));
}
