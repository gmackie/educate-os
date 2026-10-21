import { EyeIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { PRIVACY_LABEL } from "./labels.ts";

/** Who can see the work in a place: the student alone, or their teacher too once it is shared. */
export const PrivacyNote = ({ scope }: { scope: keyof typeof PRIVACY_LABEL }) => (
  <p className="flex items-center gap-2 text-sm text-kumo-subtle">
    {scope === "personal" ? <LockSimpleIcon aria-hidden size={16} /> : <EyeIcon aria-hidden size={16} />}
    {PRIVACY_LABEL[scope]}
  </p>
);
