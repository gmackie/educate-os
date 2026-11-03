import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button, Text } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, CheckIcon, EraserIcon, FloppyDiskIcon, TrashIcon } from "@phosphor-icons/react";
import { useAnnounce } from "../AppContext.tsx";
import { CANVAS_HEIGHT, CANVAS_WIDTH, canvasPoint, drawAll, drawStroke, PAPER, PEN_COLOURS, PEN_WIDTHS, type Stroke } from "./drawing.ts";
import { toBase64, type PickedFile } from "./uploadFormats.ts";

const ERASER = "eraser";

/**
 * A drawing pad for young learners: big pens in eight colours, an eraser, undo and clear, drawn
 * with a finger, a pen or the mouse (pointer events cover all three, and the canvas takes no
 * scrolling gestures). Saving hands over the drawing as a PNG. Drawing needs a pointer, so the
 * step also offers a photo upload, which is how a keyboard-only student hands in a picture.
 */
export const DrawingPad = ({ stepTitle, disabled, onDrawn }: {
  stepTitle: string;
  disabled: boolean;
  onDrawn: (file: PickedFile) => void;
}) => {
  const announce = useAnnounce();
  const canvas = useRef<HTMLCanvasElement>(null);
  const active = useRef<{ pointerId: number; stroke: Stroke } | undefined>(undefined);
  const [strokes, setStrokes] = useState<readonly Stroke[]>([]);
  const [pen, setPen] = useState(PEN_COLOURS[0]!.value);
  const [width, setWidth] = useState(PEN_WIDTHS[0]!.value);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const context = () => canvas.current?.getContext("2d") ?? null;

  // The canvas shows the committed strokes; a stroke in progress is drawn onto it as it goes.
  useEffect(() => {
    const drawing = canvas.current?.getContext("2d");
    if (drawing) drawAll(drawing, strokes);
  }, [strokes]);

  const begin = (event: PointerEvent<HTMLCanvasElement>) => {
    if (disabled || active.current !== undefined) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const stroke: Stroke = { color: pen === ERASER ? PAPER : pen, width, points: [canvasPoint(event.currentTarget, event.clientX, event.clientY)] };
    active.current = { pointerId: event.pointerId, stroke };
    const drawing = context();
    if (drawing) drawStroke(drawing, stroke);
  };

  const extend = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = active.current;
    if (current === undefined || current.pointerId !== event.pointerId) return;
    const last = current.stroke.points.at(-1)!;
    const point = canvasPoint(event.currentTarget, event.clientX, event.clientY);
    current.stroke.points.push(point);
    const drawing = context();
    if (drawing) drawStroke(drawing, { ...current.stroke, points: [last, point] });
  };

  const end = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = active.current;
    if (current === undefined || current.pointerId !== event.pointerId) return;
    active.current = undefined;
    setStrokes((previous) => [...previous, current.stroke]);
  };

  const save = () => {
    setProblem(undefined);
    const failed = () => setProblem("We couldn't save your drawing. Try again.");
    const target = canvas.current;
    if (target === null || typeof target.toBlob !== "function") return failed();
    target.toBlob((blob) => {
      if (blob === null) return failed();
      void blob.arrayBuffer().then(
        (buffer) => onDrawn({ kind: "bytes", name: "Your drawing", mediaType: "image/png", base64: toBase64(new Uint8Array(buffer)) }),
        failed,
      );
    }, "image/png");
  };

  const empty = strokes.length === 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Pen colour">
        {PEN_COLOURS.map((colour) => (
          <Button
            key={colour.value}
            variant="outline"
            shape="square"
            size="lg"
            aria-label={colour.name}
            aria-pressed={pen === colour.value}
            className={pen === colour.value ? "ring-2 ring-kumo-focus" : undefined}
            disabled={disabled}
            onClick={() => setPen(colour.value)}
            icon={
              <span aria-hidden className="flex size-7 items-center justify-center rounded-full" style={{ backgroundColor: colour.value }}>
                {pen === colour.value ? <CheckIcon weight="bold" className="text-kumo-contrast" /> : null}
              </span>
            }
          />
        ))}
        <Button
          variant="outline"
          size="lg"
          aria-pressed={pen === ERASER}
          className={pen === ERASER ? "ring-2 ring-kumo-focus" : undefined}
          disabled={disabled}
          icon={<EraserIcon aria-hidden size={24} />}
          onClick={() => setPen(ERASER)}
        >
          Eraser
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Pen size">
        {PEN_WIDTHS.map((option) => (
          <Button
            key={option.value}
            variant="outline"
            size="lg"
            aria-pressed={width === option.value}
            className={width === option.value ? "ring-2 ring-kumo-focus" : undefined}
            disabled={disabled}
            icon={<span aria-hidden className="rounded-full bg-kumo-contrast" style={{ width: option.value / 2, height: option.value / 2 }} />}
            onClick={() => setWidth(option.value)}
          >
            {option.name}
          </Button>
        ))}
      </div>

      <canvas
        ref={canvas}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        role="img"
        aria-label={`Drawing space for ${stepTitle}. Draw with your finger, a pen or the mouse.`}
        className="h-auto w-full max-w-3xl cursor-crosshair touch-none rounded-lg border-2 border-kumo-line"
        onPointerDown={begin}
        onPointerMove={extend}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg" icon={<ArrowCounterClockwiseIcon aria-hidden />} disabled={disabled || empty} onClick={() => (setStrokes(strokes.slice(0, -1)), announce("Took back the last line."))}>
          Undo
        </Button>
        <Button size="lg" variant="secondary-destructive" icon={<TrashIcon aria-hidden />} disabled={disabled || empty} onClick={() => (setStrokes([]), announce("Drawing cleared."))}>
          Clear
        </Button>
        <Button variant="primary" size="lg" className="min-h-14 px-6 text-lg" icon={<FloppyDiskIcon aria-hidden />} disabled={disabled || empty} onClick={save}>
          Save my drawing
        </Button>
      </div>
      {problem === undefined ? null : <Text variant="error" size="sm"><span role="alert">{problem}</span></Text>}
    </div>
  );
};
