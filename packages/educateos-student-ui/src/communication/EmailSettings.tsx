import { useState } from "react";
import { Banner, Switch, Text } from "@cloudflare/kumo";
import { InfoIcon } from "@phosphor-icons/react";
import { useApi } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { ErrorState } from "../ErrorState.tsx";
import type { Preferences } from "../model.ts";

type Kind = keyof Preferences["email"];

/** The emails each reader can turn on or off: a student's notifications, a family's weekly update. */
const KINDS: Readonly<Record<"student" | "family", readonly { kind: Kind; label: string }[]>> = {
  student: [
    { kind: "announcements", label: "New announcements" },
    { kind: "assignments", label: "New assignments and work due soon" },
    { kind: "feedback", label: "Feedback from my teachers" },
    { kind: "grades", label: "Grades posted" },
  ],
  family: [{ kind: "digest", label: "A weekly update about my children's classes" }],
};

/**
 * Which emails the reader gets. Each switch saves at once. Where the school sends no email there
 * are no switches, only a note saying so (SCHO-222); where it has no address for the reader, the
 * switches stay, with a note on why nothing arrives yet.
 */
export const EmailSettings = ({ initial, audience = "student" }: { initial: Preferences; audience?: "student" | "family" }) => {
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

  if (!preferences.emailEnabled) {
    return (
      <Banner
        variant="secondary"
        icon={<InfoIcon weight="fill" />}
        title="Your school doesn't send email from EducateOS"
        description={audience === "student" ? "You'll still see everything under Notifications." : "You'll still see everything here when you sign in."}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {preferences.hasEmailAddress ? null : (
        <Banner variant="secondary" icon={<InfoIcon weight="fill" />} title="Your school has no email address for you" description="Ask your school to add one if you want these emails." />
      )}
      <Text variant="secondary">Email me about:</Text>
      {KINDS[audience].map(({ kind, label }) => (
        <Switch key={kind} label={label} checked={preferences.email[kind]} disabled={saving !== undefined} onCheckedChange={(on) => void change(kind, on)} />
      ))}
      {failed === undefined ? null : <ErrorState error={failed} title="We couldn't save that change" />}
    </div>
  );
};
