// Minimal, dependency-free FLAC encoder.
//
// Emits a valid FLAC stream using VERBATIM subframes (16-bit, stereo-independent):
// no lossy steps, no compression search — every sample is stored exactly, so the
// output is truly lossless and decodes in any FLAC-aware player (incl. Chrome's
// decodeAudioData, which we use to verify). Compression is skipped for simplicity;
// file size is comparable to 16-bit PCM.

const BLOCK = 4096;

// CRC-8, poly x^8+x^2+x^1+1 (0x07), over the frame header.
function crc8(bytes: Uint8Array, start: number, end: number) {
  let c = 0;
  for (let i = start; i < end; i++) {
    c ^= bytes[i];
    for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

// CRC-16, poly x^16+x^15+x^2+1 (0x8005), over the whole frame.
function crc16(bytes: Uint8Array, start: number, end: number) {
  let c = 0;
  for (let i = start; i < end; i++) {
    c ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

// UTF-8-style coding of the frame number (fixed block size).
function utf8Coded(n: number): number[] {
  if (n < 0x80) return [n];
  let count: number;
  if (n < 0x800) count = 1; else if (n < 0x10000) count = 2; else if (n < 0x200000) count = 3; else if (n < 0x4000000) count = 4; else count = 5;
  const out: number[] = [];
  for (let i = 0; i < count; i++) { out.unshift(0x80 | (n & 0x3f)); n = Math.floor(n / 64); }
  const lead = [0, 0xc0, 0xe0, 0xf0, 0xf8, 0xfc][count];
  out.unshift(lead | n);
  return out;
}

// STREAMINFO metadata block (34 bytes) via a small MSB-first bit writer.
function streamInfo(total: number, sampleRate: number): number[] {
  const bytes: number[] = []; let cur = 0, nb = 0;
  const w = (val: number, n: number) => { for (let i = n - 1; i >= 0; i--) { cur = (cur << 1) | ((Math.floor(val / 2 ** i)) & 1); if (++nb === 8) { bytes.push(cur); cur = 0; nb = 0; } } };
  w(BLOCK, 16); w(BLOCK, 16); w(0, 24); w(0, 24); w(sampleRate, 20); w(1, 3); w(15, 5);
  w(Math.floor(total / 2 ** 32), 4); w(total >>> 0, 32);
  for (let i = 0; i < 16; i++) w(0, 8); // MD5 = unknown
  return bytes;
}

export function encodeFlac(chL: Float32Array, chR: Float32Array, sampleRate: number): Uint8Array {
  const total = chL.length;
  const frames = Math.ceil(total / BLOCK);
  // Upper bound: header(≈12) + 2 ch * (1 + 2*BLOCK) + crc(2) per frame + preamble.
  const cap = 42 + frames * (16 + 2 * (1 + 2 * BLOCK));
  const out = new Uint8Array(cap);
  let p = 0;
  const push = (b: number) => { out[p++] = b & 0xff; };

  out.set([0x66, 0x4c, 0x61, 0x43], p); p += 4;           // "fLaC"
  out.set([0x80, 0x00, 0x00, 0x22], p); p += 4;           // metadata header: last, STREAMINFO, len=34
  out.set(streamInfo(total, sampleRate), p); p += 34;

  const to16 = (x: number) => { let s = Math.round(x * 32767); if (s > 32767) s = 32767; else if (s < -32768) s = -32768; return s < 0 ? s + 0x10000 : s; };

  for (let f = 0; f < frames; f++) {
    const off = f * BLOCK;
    const bs = Math.min(BLOCK, total - off);
    const frameStart = p;
    push(0xff); push(0xf8);                                // sync + fixed block size
    const blockCode = bs === BLOCK ? 0b1100 : 0b0111;
    push((blockCode << 4) | 0b0000);                       // block size code + sample rate (from STREAMINFO)
    push((0b0001 << 4) | (0b100 << 1) | 0);                // 2-ch independent · 16-bit · reserved
    for (const b of utf8Coded(f)) push(b);
    if (bs !== BLOCK) { push(((bs - 1) >> 8) & 0xff); push((bs - 1) & 0xff); }
    push(crc8(out, frameStart, p));                        // header CRC-8
    for (const ch of [chL, chR]) {
      push(0x02);                                          // verbatim subframe header
      for (let i = 0; i < bs; i++) { const v = to16(ch[off + i]); push((v >> 8) & 0xff); push(v & 0xff); }
    }
    const c = crc16(out, frameStart, p);
    push((c >> 8) & 0xff); push(c & 0xff);                 // frame CRC-16
  }
  return out.subarray(0, p);
}

export function encodeFlacFromBuffer(buffer: AudioBuffer): Uint8Array {
  const l = buffer.getChannelData(0);
  const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
  return encodeFlac(l, r, buffer.sampleRate);
}

export function downloadBytes(bytes: Uint8Array, filename: string, mime = "audio/flac") {
  const blob = new Blob([bytes.slice()], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}
