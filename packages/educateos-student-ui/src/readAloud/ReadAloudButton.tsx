import { Button } from "@cloudflare/kumo";
import { SpeakerHighIcon, StopIcon } from "@phosphor-icons/react";
import type { ReadAloudControl } from "./useReadAloud.ts";

/**
 * "Read to me": a toggle that reads its text aloud and, pressed again, stops. Its name stays the
 * same while it reads; `aria-pressed` says whether it is reading. Not rendered where the browser
 * cannot speak. `prominent` is the large version young learners get.
 */
export const ReadAloudButton = ({ control, prominent = false }: { control: ReadAloudControl; prominent?: boolean }) => {
  if (!control.available) return null;
  const Icon = control.reading ? StopIcon : SpeakerHighIcon;
  return (
    <Button
      variant={prominent ? "primary" : "ghost"}
      size={prominent ? "lg" : "sm"}
      icon={<Icon aria-hidden weight="fill" size={prominent ? 28 : undefined} />}
      aria-label={`Read ${control.label} to me`}
      aria-pressed={control.reading}
      className={prominent ? "min-h-14 px-5 text-lg" : undefined}
      onClick={control.toggle}
    >
      Read to me
    </Button>
  );
};
