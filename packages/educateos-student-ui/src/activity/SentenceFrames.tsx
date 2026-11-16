import { Button } from "@cloudflare/kumo";
import { SpeakerHighIcon } from "@phosphor-icons/react";
import { useReadAloud } from "../readAloud/useReadAloud.ts";

/** How a frame is spoken: a blank such as "___" is a pause, not a run of underscores. */
const spoken = (frame: string) => frame.replace(/_{2,}/g, " … ");

const Frame = ({ frame }: { frame: string }) => {
  const control = useReadAloud(spoken(frame), `“${frame}”`);
  return (
    <li className={`flex items-center gap-1 rounded-full border border-kumo-line px-4 py-2 text-xl ${control.reading ? "bg-kumo-info-tint" : ""}`}>
      <span>{frame}</span>
      {control.available ? (
        <Button variant="ghost" shape="circle" size="sm" aria-label={`Read “${frame}” to me`} aria-pressed={control.reading} icon={<SpeakerHighIcon aria-hidden weight="fill" />} onClick={control.toggle} />
      ) : null}
    </li>
  );
};

/** Sentence starters a young learner can say or write their answer from, each read aloud on its own. */
export const SentenceFrames = ({ frames }: { frames: readonly string[] }) => (
  <section aria-label="Sentence starters" className="flex flex-col gap-2">
    <p className="text-lg font-semibold">Try saying:</p>
    <ul className="flex flex-wrap gap-2">
      {frames.map((frame) => <Frame key={frame} frame={frame} />)}
    </ul>
  </section>
);

