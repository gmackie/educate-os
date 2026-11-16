import { useState } from "react";
import { Button } from "@cloudflare/kumo";
import { ArrowArcLeftIcon, ArrowArcRightIcon, ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { BIG, type ItemProps } from "./types.ts";

/**
 * A number line from 0 to 10 or 20. To place a number the child taps its mark. To jump, a frog
 * starts on the start mark and the child moves it one jump at a time (or taps where they think it
 * lands); the marks it passes are recorded, so a parent can see how the child counted.
 */
export const NumberLineItem = ({ item, disabled, onAnswer }: ItemProps<"place-on-line" | "number-line-jump">) => {
  const jumping = item.type === "number-line-jump";
  const start = jumping ? item.start : undefined;
  const [at, setAt] = useState<number | undefined>(start);
  const [path, setPath] = useState<number[]>([]);
  const marks = Array.from({ length: item.max + 1 }, (_, n) => n);
  const jump = (step: 1 | -1) => {
    const from = at ?? 0;
    const to = Math.min(item.max, Math.max(0, from + step));
    setAt(to);
    setPath((p) => [...p, to]);
  };
  const jumps = path.length;
  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-x-auto px-1 pb-2">
        <ol aria-label={`Number line from 0 to ${item.max}`} className="flex min-w-max items-end gap-1 border-b-4 border-kumo-hairline pb-1">
          {marks.map((n) => {
            const here = at === n;
            const visited = path.includes(n);
            return (
              <li key={n} className="flex w-12 flex-col items-center gap-1">
                <span aria-hidden className="h-10 text-3xl">{here ? "🐸" : visited ? "·" : ""}</span>
                <Button
                  className={`h-12 w-12 text-xl ${n === start ? "ring-2 ring-kumo-brand" : ""}`}
                  variant={here ? "primary" : "secondary"}
                  aria-pressed={here}
                  aria-label={n === start ? `${n}, the start` : String(n)}
                  disabled={disabled}
                  onClick={() => {
                    setAt(n);
                    setPath([]);
                  }}
                >
                  {String(n)}
                </Button>
              </li>
            );
          })}
        </ol>
      </div>
      {jumping ? (
        <div className="flex flex-col gap-3">
          <p aria-live="polite" className="text-xl">{jumps === 0 ? `The frog is on ${at}.` : `${jumps} ${jumps === 1 ? "jump" : "jumps"}. The frog is on ${at}.`}</p>
          <div className="flex flex-wrap gap-3">
            <Button className={BIG} icon={<ArrowArcLeftIcon aria-hidden />} disabled={disabled || at === 0} onClick={() => jump(-1)}>Jump back</Button>
            <Button className={BIG} icon={<ArrowArcRightIcon aria-hidden />} disabled={disabled || at === item.max} onClick={() => jump(1)}>Jump forward</Button>
            <Button className={BIG} icon={<ArrowCounterClockwiseIcon aria-hidden />} disabled={disabled || (at === start && jumps === 0)} onClick={() => {
              setAt(start);
              setPath([]);
            }}>Start over</Button>
          </div>
        </div>
      ) : null}
      <Button
        className={`${BIG} self-start`}
        variant="primary"
        disabled={disabled || at === undefined || (jumping && at === start && jumps === 0)}
        onClick={() => onAnswer({ kind: "number", value: at!, ...(path.length === 0 ? {} : { path }) })}
      >
        {jumping ? "I landed here" : "That's my answer"}
      </Button>
    </div>
  );
};
