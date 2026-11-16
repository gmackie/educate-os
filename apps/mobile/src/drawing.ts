// The drawing pad's picture as strokes, so undo is dropping the last one (SCHO-342). The same
// canvas, colours and pens as the web's pad (packages/educateos-student-ui/src/activity/drawing.ts):
// a fixed 960×720 canvas scaled to fit the screen, so a drawing saves the same on any device.

export const CANVAS_WIDTH = 960;
export const CANVAS_HEIGHT = 720;

export type Point = { x: number; y: number };
export type Stroke = { color: string; width: number; points: Point[] };

/** The colours a young learner draws with, named as they would say them. Fixed in light and dark. */
export const PEN_COLOURS: readonly { name: string; value: string }[] = [
  { name: 'Black', value: '#1f2937' },
  { name: 'Red', value: '#dc2626' },
  { name: 'Orange', value: '#ea580c' },
  { name: 'Yellow', value: '#facc15' },
  { name: 'Green', value: '#16a34a' },
  { name: 'Blue', value: '#2563eb' },
  { name: 'Purple', value: '#9333ea' },
  { name: 'Brown', value: '#92400e' },
];

/** The paper colour. The eraser draws in it, and a saved drawing has it behind every stroke. */
export const PAPER = '#ffffff';

/** The pen widths, big first: small hands draw broad lines. */
export const PEN_WIDTHS: readonly { name: string; value: number }[] = [
  { name: 'Big', value: 28 },
  { name: 'Medium', value: 14 },
  { name: 'Thin', value: 6 },
];

/** A touch at (x, y) on a pad shown `width`×`height` points, in canvas pixels, kept on the canvas. */
export function canvasPoint(x: number, y: number, width: number, height: number): Point {
  const sx = width > 0 ? CANVAS_WIDTH / width : 1, sy = height > 0 ? CANVAS_HEIGHT / height : 1;
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  return { x: Math.round(clamp(x * sx, CANVAS_WIDTH) * 10) / 10, y: Math.round(clamp(y * sy, CANVAS_HEIGHT) * 10) / 10 };
}

/**
 * A stroke as an SVG path. A single point becomes a zero-length line, which a round cap draws as a
 * dot of the pen's width.
 */
export function strokePath(stroke: Stroke): string {
  const [first, ...rest] = stroke.points;
  if (!first) return '';
  if (rest.length === 0) return 'M' + first.x + ' ' + first.y + 'L' + first.x + ' ' + first.y;
  return 'M' + first.x + ' ' + first.y + rest.map((p) => 'L' + p.x + ' ' + p.y).join('');
}

/** Adds a point unless it is too close to the last to change the line, keeping long strokes small. */
export function extend(stroke: Stroke, point: Point): Stroke {
  const last = stroke.points.at(-1);
  if (last && Math.hypot(last.x - point.x, last.y - point.y) < 2) return stroke;
  return { ...stroke, points: [...stroke.points, point] };
}

/**
 * The size, in points, of the hidden view a drawing is exported from, so the PNG is exactly the
 * canvas. react-native-svg exports a view at its own size times the screen's pixel ratio (iOS
 * ignores a requested size for the drawing itself, so asking for 960×720 draws the pad's on-screen
 * size in one corner); a view of 960×720 pixels exports the whole canvas.
 */
export function exportViewSize(pixelRatio: number): { width: number; height: number } {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  return { width: CANVAS_WIDTH / ratio, height: CANVAS_HEIGHT / ratio };
}
