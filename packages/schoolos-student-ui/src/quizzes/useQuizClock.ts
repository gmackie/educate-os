import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useAnnounce } from "../AppContext.tsx";

/** Minutes left at which the time remaining is announced. */
export const ANNOUNCED_MINUTES = [10, 5, 1] as const;

const announcementFor = (minutes: number) => (minutes === 1 ? "1 minute left in this quiz." : `${minutes} minutes left in this quiz.`);

/**
 * The time left in an attempt, counted on the district's clock rather than the device's: the gap
 * between the two is measured once from `serverNow`, so a device clock that is wrong neither gives
 * nor takes time. Ticks every second; announces politely only at {@link ANNOUNCED_MINUTES} and when
 * time is up, never each second. Without a deadline there is no clock.
 */
export const useQuizClock = (deadline: string | undefined, serverNow: string) => {
  const announce = useAnnounce();
  const [offset] = useState(() => Date.parse(serverNow) - Date.now());
  const [now, setNow] = useState(() => Date.now());
  const end = deadline === undefined ? undefined : Date.parse(deadline);
  // Thresholds already behind the attempt when it opened are not announced late.
  const announced = useRef(new Set<number>(end === undefined ? [] : ANNOUNCED_MINUTES.filter((m) => end - (Date.now() + offset) <= m * 60_000)));
  const ended = useRef(end !== undefined && end - (Date.now() + offset) <= 0);

  const tick = useEffectEvent(() => {
    if (end === undefined) return;
    const at = Date.now();
    setNow(at);
    const left = end - (at + offset);
    for (const minutes of ANNOUNCED_MINUTES) {
      if (left <= minutes * 60_000 && left > 0 && !announced.current.has(minutes)) {
        // Crossing several at once (a sleeping device) announces only the latest.
        for (const passed of ANNOUNCED_MINUTES) if (passed >= minutes) announced.current.add(passed);
        announce(announcementFor(minutes));
      }
    }
    if (left <= 0 && !ended.current) {
      ended.current = true;
      announce("Time is up. This attempt can no longer be changed or submitted.");
    }
  });

  useEffect(() => {
    if (end === undefined) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [end]);

  const remaining = end === undefined ? undefined : end - (now + offset);
  return { remaining, timeUp: remaining !== undefined && remaining <= 0 };
};
