import { Text } from "@cloudflare/kumo";
import { useQuery } from "../api.tsx";
import { EmailSettings } from "../communication/EmailSettings.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";

/**
 * A guardian's settings: whether they get the weekly email update about their children's classes,
 * which the update itself tells them they can turn off here (SCHO-222).
 */
export const FamilySettingsPage = () => {
  const [preferences, reload] = useQuery("preferences", (api) => api.call("me.preferences"));
  return (
    <div className="flex flex-col gap-8">
      <Text variant="heading" size="lg" as="h1">Settings</Text>
      <section aria-labelledby="email-settings" className="flex flex-col gap-3">
        <Text variant="heading" as="h2"><span id="email-settings">Email</span></Text>
        {preferences.status === "loading" ? <LoadingSkeleton label="Loading your email settings" lines={1} /> : null}
        {preferences.status === "error" ? <ErrorState error={preferences.error} title="We couldn't load your email settings" onRetry={reload} /> : null}
        {preferences.status === "ready" ? <EmailSettings initial={preferences.data} audience="family" /> : null}
      </section>
    </div>
  );
};
