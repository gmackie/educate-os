// The one-time "Get <school> on your phone" banner on the student's Home (SCHO-260, plan §4):
// offered where the district has the mobile app, until the student dismisses it, which this
// browser remembers.
import { useState } from "react";
import { Button, LinkButton, Surface, Text } from "@cloudflare/kumo";
import { DeviceMobileIcon, XIcon } from "@phosphor-icons/react";
import { CONNECT_PHONE_PATH } from "./paths.ts";
import { useDistrictShell } from "../shell.tsx";

/** Where the dismissal is kept: on the district origin, so it holds across its apps. */
export const PHONE_BANNER_DISMISSED_KEY = "educateos:phone-banner-dismissed";

const dismissedBefore = (): boolean => {
  try {
    return localStorage.getItem(PHONE_BANNER_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
};

export const PhoneBanner = () => {
  const shell = useDistrictShell();
  const [dismissed, setDismissed] = useState(dismissedBefore);
  if (shell === undefined || !shell.school.features.mobile || dismissed) return null;
  const title = `Get ${shell.school.name} on your phone`;
  const dismiss = () => {
    try {
      localStorage.setItem(PHONE_BANNER_DISMISSED_KEY, "true");
    } catch {
      // Storage is off: the banner stays dismissed for this page only.
    }
    setDismissed(true);
  };
  return (
    <Surface as="section" aria-labelledby="phone-banner-title" className="flex flex-wrap items-center gap-4 rounded-xl p-4">
      <DeviceMobileIcon aria-hidden size={32} className="shrink-0 text-kumo-brand" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Text variant="heading" as="h2"><span id="phone-banner-title">{title}</span></Text>
        <Text variant="secondary">Scan once and you're signed in. No password on the phone.</Text>
      </div>
      <LinkButton href={CONNECT_PHONE_PATH} variant="primary">Show code</LinkButton>
      <Button variant="ghost" shape="square" icon={<XIcon aria-hidden />} aria-label={`Dismiss: ${title}`} onClick={dismiss} />
    </Surface>
  );
};
