// The drawing pad's picture as strokes, so undo is dropping the last one and redrawing (SCHO-323).
// The canvas is a fixed size in its own pixels and scaled to fit the screen, so a drawing saves the
// same whatever device made it.

/** The canvas's own size, in pixels: 4:3, large enough to print. */
export const CANVAS_WIDTH = 960;
export const CANVAS_HEIGHT = 720;

/** A point on the canvas, in canvas pixels. */
export interface Point {
  x: number;
  y: number;
}

/** One continuous line of one colour and width. */
export interface Stroke {
  color: string;
  width: number;
  points: Point[];
}

/**
 * The colours a young learner draws with, named as they would say them. They are the drawing's
 * content, not interface styling, so they are fixed colours rather than theme tokens: a drawing
 * looks the same in a light or a dark theme, and on paper.
 */
export const PEN_COLOURS: readonly { name: string; value: string }[] = [
  { name: "Black", value: "#1f2937" },
  { name: "Red", value: "#dc2626" },
  { name: "Orange", value: "#ea580c" },
  { name: "Yellow", value: "#facc15" },
  { name: "Green", value: "#16a34a" },
  { name: "Blue", value: "#2563eb" },
  { name: "Purple", value: "#9333ea" },
  { name: "Brown", value: "#92400e" },
];

/** The paper colour. The eraser draws in it, and a saved drawing has it behind every stroke. */
export const PAPER = "#ffffff";

/** The pen widths, big first: small hands draw broad lines. */
export const PEN_WIDTHS: readonly { name: string; value: number }[] = [
  { name: "Big", value: 28 },
  { name: "Medium", value: 14 },
  { name: "Thin", value: 6 },
];

/** Where a pointer event lands on the canvas, in canvas pixels, whatever size the canvas is shown at. */
export const canvasPoint = (canvas: HTMLCanvasElement, clientX: number, clientY: number): Point => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width === 0 ? 1 : CANVAS_WIDTH / rect.width;
  const scaleY = rect.height === 0 ? 1 : CANVAS_HEIGHT / rect.height;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
};

/** Draws one stroke. A single point is a dot. */
export const drawStroke = (context: CanvasRenderingContext2D, stroke: Stroke): void => {
  const [first, ...rest] = stroke.points;
  if (first === undefined) return;
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineWidth = stroke.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  if (rest.length === 0) {
    context.beginPath();
    context.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (const point of rest) context.lineTo(point.x, point.y);
  context.stroke();
};

/** Paints the paper and every stroke in order. */
export const drawAll = (context: CanvasRenderingContext2D, strokes: readonly Stroke[]): void => {
  context.fillStyle = PAPER;
  context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  for (const stroke of strokes) drawStroke(context, stroke);
};
