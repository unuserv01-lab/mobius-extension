// Generates simple MOBIUS icons (gradient blue->purple with a white "M" block)
// as PNG files into public/icons/. No external deps: raw PNG encoder via zlib.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  // diagonal gradient #1a73e8 -> #7c4dff, white "M" in the middle
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      const r = Math.round(0x1a + (0x7c - 0x1a) * t);
      const g = Math.round(0x73 + (0x4d - 0x73) * t);
      const b = Math.round(0xe8 + (0xff - 0xe8) * t);
      // white "M": two vertical bars + diagonal strokes in the middle band
      const m = size / 4;
      const inM = y >= m && y <= size - m && (
        (x >= m && x <= m + size / 10) ||
        (x >= size - m - size / 10 && x <= size - m) ||
        (x >= size / 2 - size / 20 && x <= size / 2 + size / 20 && y <= size / 2) ||
        (x >= m + size / 10 && x <= size / 2 && y - m <= (x - m) * 0.9 && y - m >= (x - m) * 0.9 - size / 10) ||
        (x >= size / 2 && x <= size - m - size / 10 && size - m - y <= (size - m - x) * 0.9 + size / 10 && size - m - y >= (size - m - x) * 0.9)
      );
      const off = y * (size * 3 + 1) + 1 + x * 3;
      if (inM) { raw[off] = 255; raw[off + 1] = 255; raw[off + 2] = 255; }
      else { raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const s of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${s}.png`), png(s));
  console.log('wrote icon' + s + '.png');
}
