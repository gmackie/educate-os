import { Fragment, useEffect, useId, useRef, useState } from "react";
import { Badge, Button, Input, Surface, Text } from "@cloudflare/kumo";
import { ArrowBendUpLeftIcon, LockKeyIcon, ShieldCheckIcon, SpeakerHighIcon } from "@phosphor-icons/react";
import { canSpeak, speak, stopSpeaking } from "@gadgets/bundled-blueprints/libraries/tutor/client";
import type { GradeBand } from "../districts/index.ts";
import type { TutorPersona } from "@gadgets/bundled-blueprints/libraries/tutor/client";
import { answer, scriptFor, TUTORS, type Exchange, type Screening } from "./scripts.ts";

/** The label every simulated tutor carries, so nobody takes it for the live AI. */
export const SIMULATED_NOTE = "Simulated preview — the live district runs this on real AI with safety screening.";

const GRADES: Record<GradeBand, string> = { "K-2": "grades K–2", "3-5": "grades 3–5", "6-8": "grades 6–8", "9-12": "grades 9–12" };

/** How long the tutor seems to think, so a reply reads as one. */
const THINKING_MS = 450;

interface SimulatedTutorProps {
  band: GradeBand;
  /** The activity the student asked from, which picks the script. */
  activityTitle: string;
  /** Called the first time the student asks something. */
  onAsked?: () => void;
}

/** What Hall Monitor decided about a message, as the live district would show it in its review. */
const ScreeningNote = ({ band, tutorName, screening }: { band: GradeBand; tutorName: string; screening: Screening }) => {
  const [Icon, text] = screening.verdict === "allowed"
    ? [ShieldCheckIcon, `Hall Monitor checked this for ${GRADES[band]}: allowed, sent to ${tutorName}.`]
    : screening.verdict === "redirected"
      ? [ArrowBendUpLeftIcon, `Hall Monitor: ${screening.why}. Not sent to the AI; ${tutorName} steers back kindly.`]
      : [LockKeyIcon, `Hall Monitor: ${screening.why}. Neither sent nor kept.`];
  return (
    <p className="flex items-start gap-1.5 text-xs text-kumo-subtle" data-screening={screening.verdict}>
      <Icon aria-hidden size={14} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </p>
  );
};

/** One thing the tutor said, with a button that reads it aloud where the browser can. */
const TutorBubble = ({ tutor, text, speaks, slow }: { tutor: TutorPersona; text: string; speaks: boolean; slow: boolean }) => (
  <li className="flex items-start gap-2">
    <span aria-hidden className="text-2xl leading-none">{tutor.avatar}</span>
    <div className="min-w-0 flex-1 rounded-lg border-l-4 bg-kumo-recessed px-3 py-2" style={{ borderLeftColor: tutor.theme.accent }}>
      <span className="sr-only">{`${tutor.name} said: `}</span>
      <Text>{text}</Text>
    </div>
    {speaks && <Button size="sm" variant="ghost" shape="square" icon={<SpeakerHighIcon aria-hidden />} aria-label="Read this aloud" onClick={() => speak(text, { slow })} />}
  </li>
);

/**
 * The band's AI tutor as a scripted, clearly labelled preview (SCHO-324): the demo is "no AI", so
 * it answers from {@link scriptFor}'s script for the activity, shows the Hall Monitor screening each
 * message gets on the live district, offers one-tap replies, and reads replies aloud for K-2 as the
 * Reading Buddy does. It opens from the activity's class-helper slot.
 */
export const SimulatedTutor = ({ band, activityTitle, onAsked }: SimulatedTutorProps) => {
  const tutor = TUTORS[band];
  const script = scriptFor(band, activityTitle);
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Exchange[]>([]);
  const [thinking, setThinking] = useState<string>();
  const [draft, setDraft] = useState("");
  const asked = useRef(false);
  const end = useRef<HTMLLIElement>(null);
  const speaks = canSpeak();
  const slow = band === "K-2";

  useEffect(() => () => {
    stopSpeaking();
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [turns, thinking]);
  // A pending reply arrives after a moment, unless the panel is gone.
  useEffect(() => {
    if (thinking === undefined) return;
    const timer = setTimeout(() => {
      const exchange = answer(band, activityTitle, thinking);
      setTurns((previous) => [...previous, exchange]);
      setThinking(undefined);
      if (tutor.readAloud && speaks) speak(exchange.reply, { slow });
    }, THINKING_MS);
    return () => clearTimeout(timer);
  }, [thinking, band, activityTitle, tutor.readAloud, speaks, slow]);

  const send = (text: string) => {
    const message = text.trim();
    if (message === "" || thinking !== undefined) return;
    stopSpeaking();
    setThinking(message);
    setDraft("");
    if (!asked.current) {
      asked.current = true;
      onAsked?.();
    }
  };

  return (
    <Surface as="aside" aria-labelledby={headingId} data-slot="ai-help" className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="text-4xl leading-none">{tutor.avatar}</span>
        <div className="flex min-w-0 flex-1 flex-col">
          <Text variant="heading" as="h2">
            <span id={headingId}>{`${tutor.name} (simulated)`}</span>
          </Text>
          <Text variant="secondary" size="sm">{tutor.tagline}</Text>
        </div>
        {/* The heading and the note say so on a phone, where the badge would squeeze the name. */}
        <span className="max-sm:hidden"><Badge variant="beta">Simulated preview</Badge></span>
      </div>
      <Text size="sm" variant="secondary">{SIMULATED_NOTE}</Text>
      {!open ? (
        <div>
          <Button variant="primary" onClick={() => setOpen(true)}>{`Ask ${tutor.name}`}</Button>
        </div>
      ) : (
        <>
          <ol aria-label={`Conversation with ${tutor.name}`} aria-live="polite" className={`flex flex-col gap-3 ${band === "K-2" ? "text-lg" : ""}`}>
            <TutorBubble tutor={tutor} text={tutor.greeting} speaks={speaks} slow={slow} />
            <TutorBubble tutor={tutor} text={script.opener} speaks={speaks} slow={slow} />
            {turns.map((turn, index) => (
              <Fragment key={index}>
                <li className="flex flex-col items-end gap-1">
                  <div className="max-w-[85%] rounded-lg bg-kumo-tint px-3 py-2">
                    <span className="sr-only">You said: </span>
                    <Text>{turn.ask}</Text>
                  </div>
                  <ScreeningNote band={band} tutorName={tutor.name} screening={turn.screening} />
                </li>
                <TutorBubble tutor={tutor} text={turn.reply} speaks={speaks} slow={slow} />
              </Fragment>
            ))}
            {thinking !== undefined && (
              <li className="flex flex-col items-end gap-1">
                <div className="max-w-[85%] rounded-lg bg-kumo-tint px-3 py-2"><Text>{thinking}</Text></div>
                <Text size="sm" variant="secondary">{`Hall Monitor is checking, then ${tutor.name} is thinking…`}</Text>
              </li>
            )}
            <li ref={end} aria-hidden className="h-0" />
          </ol>
          <div role="group" aria-label="Quick replies" className="flex flex-wrap gap-2">
            {script.exchanges.map((exchange) => (
              <Button key={exchange.ask} size={band === "K-2" ? "base" : "sm"} disabled={thinking !== undefined} onClick={() => send(exchange.ask)}>
                {exchange.ask}
              </Button>
            ))}
          </div>
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              send(draft);
            }}
          >
            <div className="min-w-0 flex-1">
              <Input label="Your message" placeholder={tutor.inputPlaceholder} value={draft} maxLength={500} onChange={(event) => setDraft(event.target.value)} />
            </div>
            <Button type="submit" variant="primary" disabled={draft.trim() === "" || thinking !== undefined}>Send</Button>
          </form>
          <Text size="sm" variant="secondary">{tutor.helpNote}</Text>
        </>
      )}
    </Surface>
  );
};
