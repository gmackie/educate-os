import { useState } from "react";
import { Banner, Switch, Text } from "@cloudflare/kumo";
import { InfoIcon } from "@phosphor-icons/react";
import { useApi } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { ErrorState } from "../ErrorState.tsx";
import type { Preferences } from "../model.ts";

type Kind = "announcements" | "assignments" | "feedback" | "grades";

const KINDS: readonly { kind: Kind; label: string }[] = [
  { kind: "announcements", label: "New announcements" },
  { kind: "assignments", label: "New assignments and work due soon" },
  { kind: "feedback", label: "Feedback from my teachers" },
  { kind: "grades", label: "Grades posted" },
];

/**
 * Which emails the student gets. Each switch saves at once. Where the school sends no email, or
 * has no address for the student, the switches say why nothing arrives.
 */
export const EmailSettings = ({ initial }: { initial: Preferences }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [preferences, setPreferences] = useState(initial);
  const [saving, setSaving] = useState<Kind | undefined>(undefined);
  const [failed, setFailed] = useState<unknown>(undefined);

  const change = async (kind: Kind, on: boolean) => {
    setSaving(kind);
    setFailed(undefined);
    try {
      setPreferences(await api.call("me.updatePreferences", { body: { email: { [kind]: on } } }));
      announce(on ? "Email turned on" : "Email turned off");
    } catch (error) {
      setFailed(error);
    } finally {
      setSaving(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {!preferences.emailEnabled ? (
        <Banner variant="secondary" icon={<InfoIcon weight="fill" />} title="Your school doesn't send email from SchoolOS" description="You'll still see everything under Notifications." />
      ) : !preferences.hasEmailAddress ? (
        <Banner variant="secondary" icon={<InfoIcon weight="fill" />} title="Your school has no email address for you" description="Ask your school to add one if you want these emails." />
      ) : null}
      <Text variant="secondary">Email me about:</Text>
      {KINDS.map(({ kind, label }) => (
        <Switch key={kind} label={label} checked={preferences.email[kind]} disabled={saving !== undefined} onCheckedChange={(on) => void change(kind, on)} />
      ))}
      {failed === undefined ? null : <ErrorState error={failed} title="We couldn't save that change" />}
    </div>
  );
};
