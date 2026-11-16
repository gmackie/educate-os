// The pictures and recordings young learners hand in on the showcase's picture-response and
// read-and-respond activities (SCHO-324): crayon-style drawings encoded as small, valid PNGs, and
// short recordings as valid WAVs: the child's scripted words, spoken (SCHO-328), or a hummed tune
// for a step with no spoken line. Both are made from plain data here, with no canvas, codec or
// dependency, so the seeder can make them anywhere: in Node, in a Worker, and in the in-browser demo.
import { SPOKEN_RECORDINGS } from "./recordings.ts";

/** The crayons a drawing may use. */
export type Crayon = "sky" | "sun" | "cloud" | "rain" | "grass" | "soil" | "red" | "yellow" | "blue" | "green" | "brown" | "black" | "skin" | "purple" | "orange";

/** One mark on a drawing, in a 240 by 180 picture with the origin at the top left. */
export type Mark =
  | { kind: "circle"; x: number; y: number; r: number; crayon: Paint }
  | { kind: "rect"; x: number; y: number; w: number; h: number; crayon: Paint }
  /** A thick crayon stroke through each point in turn. */
  | { kind: "stroke"; points: readonly (readonly [number, number])[]; width: number; crayon: Paint }
  /** A filled shape with these corners. */
  | { kind: "shape"; points: readonly (readonly [number, number])[]; crayon: Paint };

/** A crayon, or white paint over what is there. */
export type Paint = Crayon | "white";

/** A child's drawing: a paper colour, then marks painted in order. */
export interface Drawing {
  paper?: Paint;
  marks: readonly Mark[];
}

/** The drawing size, in pixels. */
export const DRAWING_SIZE = { width: 240, height: 180 } as const;

// White first, so a pixel's palette index 0 is the paper until painted. Sixteen entries fit a 4-bit PNG.
const PALETTE: readonly (readonly [Paint, number, number, number])[] = [
  ["white", 255, 255, 255],
  ["sky", 156, 210, 245],
  ["sun", 255, 205, 40],
  ["cloud", 205, 212, 222],
  ["rain", 45, 120, 220],
  ["grass", 90, 180, 75],
  ["soil", 140, 95, 60],
  ["red", 225, 60, 55],
  ["yellow", 250, 230, 60],
  ["blue", 40, 80, 190],
  ["green", 30, 130, 70],
  ["brown", 110, 70, 40],
  ["black", 40, 40, 45],
  ["skin", 235, 185, 145],
  ["purple", 145, 85, 195],
  ["orange", 245, 140, 40],
];
const INDEX = new Map(PALETTE.map(([name], index) => [name, index]));

/** Paints `drawing` into one palette index a pixel, row by row. */
function paint(drawing: Drawing): Uint8Array {
  const { width, height } = DRAWING_SIZE;
  const pixels = new Uint8Array(width * height).fill(INDEX.get(drawing.paper ?? "white")!);
  const set = (x: number, y: number, colour: number) => {
    if (x >= 0 && y >= 0 && x < width && y < height) pixels[y * width + x] = colour;
  };
  const disc = (cx: number, cy: number, r: number, colour: number) => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(x, y, colour);
      }
    }
  };
  for (const mark of drawing.marks) {
    const colour = INDEX.get(mark.crayon)!;
    switch (mark.kind) {
      case "circle":
        disc(mark.x, mark.y, mark.r, colour);
        break;
      case "rect":
        for (let y = mark.y; y < mark.y + mark.h; y++) for (let x = mark.x; x < mark.x + mark.w; x++) set(x, y, colour);
        break;
      case "stroke":
        for (let i = 1; i < mark.points.length; i++) {
          const [x0, y0] = mark.points[i - 1]!;
          const [x1, y1] = mark.points[i]!;
          const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
          for (let s = 0; s <= steps; s++) disc(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps, mark.width / 2, colour);
        }
        break;
      case "shape": {
        // Even-odd fill: a pixel is inside when a ray to its right crosses the outline an odd number of times.
        const ys = mark.points.map(([, y]) => y);
        for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
          for (let x = 0; x < width; x++) {
            let inside = false;
            for (let i = 0, j = mark.points.length - 1; i < mark.points.length; j = i++) {
              const [xi, yi] = mark.points[i]!;
              const [xj, yj] = mark.points[j]!;
              if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
            }
            if (inside) set(x, y, colour);
          }
        }
        break;
      }
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** `data` as a zlib stream of stored (uncompressed) deflate blocks, which every PNG reader accepts. */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65_535));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  const view = new DataView(out.buffer);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let b = 0; b < blocks; b++) {
    const chunk = data.subarray(b * 65_535, Math.min(data.length, (b + 1) * 65_535));
    out[at] = b === blocks - 1 ? 1 : 0;
    view.setUint16(at + 1, chunk.length, true);
    view.setUint16(at + 3, chunk.length ^ 0xffff, true);
    out.set(chunk, at + 5);
    at += 5 + chunk.length;
  }
  let a = 1, s = 0;
  for (const byte of data) {
    a = (a + byte) % 65_521;
    s = (s + a) % 65_521;
  }
  view.setUint32(at, ((s << 16) | a) >>> 0);
  return out;
}

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat([ascii(type), data]);
  const chunk = new Uint8Array(8 + data.length + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return chunk;
}

/** `drawing` as a 4-bit indexed-colour PNG. */
export function drawingPng(drawing: Drawing): Uint8Array {
  const { width, height } = DRAWING_SIZE;
  const pixels = paint(drawing);
  const stride = Math.ceil(width / 2);
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    // Filter type 0 (none), then two pixels a byte, high nibble first.
    const row = y * (1 + stride);
    for (let x = 0; x < width; x++) raw[row + 1 + (x >> 1)]! |= pixels[y * width + x]! << (x & 1 ? 0 : 4);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([4, 3, 0, 0, 0], 8);
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", header),
    pngChunk("PLTE", Uint8Array.from(PALETTE.flatMap(([, r, g, b]) => [r, g, b]))),
    pngChunk("IDAT", zlibStored(raw)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

/** A small, stable hash of `text`, to vary each child's recording. */
function hash(text: string): number {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

const SAMPLE_RATE = 8_000;

/**
 * A short recording of a child, as 8 kHz 8-bit mono WAV. For a seed with a spoken line, by the
 * seeder's `studentId:activityKey:stepId`, it is that line spoken (generated once by
 * `scripts/demo/spoken-recordings.ts`); for any other, a soft hummed tune of a few notes, about a
 * second and a half, that `seed` picks, so two children's recordings differ.
 */
export function recordingWav(seed: string): Uint8Array {
  const spoken = SPOKEN_RECORDINGS[seed];
  if (spoken !== undefined) return Uint8Array.from(atob(spoken), (c) => c.charCodeAt(0));
  const h = hash(seed);
  // A pentatonic scale around middle C, comfortably in a child's humming range.
  const scale = [262, 294, 330, 392, 440, 523];
  const notes = [0, 1, 2, 3].map((i) => scale[(h >>> (i * 5)) % scale.length]!);
  const noteSamples = Math.round(SAMPLE_RATE * 0.36);
  const samples = new Uint8Array(notes.length * noteSamples);
  notes.forEach((frequency, n) => {
    for (let i = 0; i < noteSamples; i++) {
      const t = i / SAMPLE_RATE;
      // A quick swell and a gentle fade, so notes do not click.
      const envelope = Math.min(1, i / 400) * Math.min(1, (noteSamples - i) / 900);
      const tone = Math.sin(2 * Math.PI * frequency * t) + 0.3 * Math.sin(4 * Math.PI * frequency * t);
      samples[n * noteSamples + i] = Math.round(128 + 70 * envelope * (tone / 1.3));
    }
  });
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  header.set(ascii("RIFF"), 0);
  view.setUint32(4, 36 + samples.length, true);
  header.set(ascii("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE, true); // bytes a second
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits a sample
  header.set(ascii("data"), 36);
  view.setUint32(40, samples.length, true);
  return concat([header, samples]);
}

/** `bytes` as base64, as the district API takes file contents. */
export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
