/* Generates build/icon.png — run with `npm run icons`.
 *
 * Drawn in code rather than committed as a binary blob so it stays diffable
 * and editable: the whole icon is the maths below. electron-builder converts
 * this single 1024px PNG into the .ico and .icns the other platforms want.
 *
 * The mark is the app itself: a clock face, with one blip on it.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;

const INK = [230, 224, 214];
const BG = [17, 15, 19];
const GOLD = [201, 162, 39];
const CLOCK = [216, 178, 94];
const RED = [176, 58, 44];

function make() {
  // RGBA, row-major, with a filter byte at the start of each row.
  const stride = SIZE * 4;
  const raw = Buffer.alloc((stride + 1) * SIZE);

  const centre = SIZE / 2;
  const radius = SIZE * 0.34;
  const ring = SIZE * 0.022;

  for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0;                  // filter: none
    const row = y * (stride + 1) + 1;

    for (let x = 0; x < SIZE; x++) {
      const dx = x - centre;
      const dy = y - centre;
      const distance = Math.hypot(dx, dy);

      let colour = BG;
      let alpha = 255;

      // Rounded-square field, so the icon reads as an app rather than a sticker.
      const inset = SIZE * 0.06;
      const corner = SIZE * 0.22;
      const fx = Math.max(inset - x, x - (SIZE - inset), 0);
      const fy = Math.max(inset - y, y - (SIZE - inset), 0);
      if (Math.hypot(fx, fy) > 0) alpha = 0;
      else {
        const cx = Math.max(inset + corner - x, x - (SIZE - inset - corner), 0);
        const cy = Math.max(inset + corner - y, y - (SIZE - inset - corner), 0);
        if (cx > 0 && cy > 0 && Math.hypot(cx, cy) > corner) alpha = 0;
      }

      // The dial.
      if (Math.abs(distance - radius) < ring) colour = GOLD;

      // Hour ticks at the quarters, and a lighter mark every hour.
      const angle = Math.atan2(dy, dx);
      if (distance < radius - ring && distance > radius - ring * 4.2) {
        const twelfth = (angle + Math.PI * 2) % (Math.PI / 6);
        const near = Math.min(twelfth, Math.PI / 6 - twelfth);
        if (near < 0.035) colour = mix(BG, INK, 0.55);
      }

      // Two hands, fixed at the hour the campaign is always about to turn.
      if (onHand(dx, dy, -Math.PI / 2.35, radius * 0.62, SIZE * 0.017)) colour = CLOCK;
      if (onHand(dx, dy, Math.PI / 5.5, radius * 0.42, SIZE * 0.022)) colour = INK;

      // The blip: someone standing somewhere, on this date.
      const bx = dx - radius * 0.52;
      const by = dy + radius * 0.5;
      if (Math.hypot(bx, by) < SIZE * 0.038) colour = RED;

      const at = row + x * 4;
      raw[at] = colour[0];
      raw[at + 1] = colour[1];
      raw[at + 2] = colour[2];
      raw[at + 3] = alpha;
    }
  }

  return png(raw);
}

function onHand(dx, dy, angle, length, width) {
  // Distance from the point to the line segment running out from the centre.
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const along = dx * ux + dy * uy;
  if (along < 0 || along > length) return false;
  const across = Math.abs(dx * -uy + dy * ux);
  return across < width;
}

const mix = (a, b, t) => a.map((value, i) => Math.round(value + (b[i] - value) * t));

// ── Minimal PNG writer ───────────────────────────────────────────────────────

function png(raw) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace

  return Buffer.concat([
    header,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, make());
console.log(`Wrote ${out} (${SIZE}×${SIZE})`);
