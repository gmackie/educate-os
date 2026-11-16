import type { ReactNode } from "react";
import { Button } from "@cloudflare/kumo";
import { SpeakerHighIcon } from "@phosphor-icons/react";
import { useSpeech } from "./speak.ts";

/**
 * A button that reads `text` aloud. With reading aloud off it is gone; where the child can't do the
 * item without hearing it (`sayInstead`), the grown-up gets the words to say instead, folded away
 * so the child isn't shown a word they're meant to spell or find.
 */
export const HearButton = ({ text, children, sayInstead, size, variant, className }: {
  text: string;
  children: ReactNode;
  sayInstead?: string;
  size?: "lg";
  variant?: "ghost";
  className?: string;
}) => {
  const { on, speak } = useSpeech();
  if (on) {
    return <Button size={size} variant={variant} className={className} icon={<SpeakerHighIcon aria-hidden />} onClick={() => speak(text)}>{children}</Button>;
  }
  if (sayInstead === undefined) return null;
  return (
    <details className="rounded-xl border border-kumo-hairline p-3">
      <summary className="cursor-pointer font-semibold">Grown-up: what to say</summary>
      <p lang="en" className="mt-2 text-xl">{sayInstead}</p>
    </details>
  );
};
