import { Text } from "@cloudflare/kumo";
import { useQuery } from "../api.tsx";
import { useDistrictOrigin } from "../AppContext.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { CalendarSubscription } from "./CalendarSubscription.tsx";
import { EmailSettings } from "./EmailSettings.tsx";

/** The student's settings: which emails they get, and their calendar link. */
export const SettingsPage = ({ origin }: { origin?: string }) => {
  const districtOrigin = useDistrictOrigin();
  const [preferences, reload] = useQuery("preferences", (api) => api.call("me.preferences"));
  return (
    <div className="flex flex-col gap-8">
      <Text variant="heading" size="lg" as="h1">Settings</Text>
      <section aria-labelledby="email-settings" className="flex flex-col gap-3">
        <Text variant="heading" as="h2"><span id="email-settings">Email</span></Text>
        {preferences.status === "loading" ? <LoadingSkeleton label="Loading your email settings" lines={2} /> : null}
        {preferences.status === "error" ? <ErrorState error={preferences.error} title="We couldn't load your email settings" onRetry={reload} /> : null}
        {preferences.status === "ready" ? <EmailSettings initial={preferences.data} /> : null}
      </section>
      <section aria-labelledby="calendar-link" className="flex flex-col gap-3">
        <Text variant="heading" as="h2"><span id="calendar-link">Calendar link</span></Text>
        <CalendarSubscription origin={origin ?? districtOrigin} />
      </section>
    </div>
  );
};
