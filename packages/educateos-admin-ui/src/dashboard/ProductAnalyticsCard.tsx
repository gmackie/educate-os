import { useState } from "react";
import { Banner, LayerCard, Switch, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { LoadState } from "../app/LoadState.tsx";
import { errorMessage, useLoad } from "../app/useLoad.ts";

const changedOn = (changedAt: string | null): string | undefined =>
  changedAt === null ? undefined : new Date(changedAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

/**
 * Product analytics (SCHO-350): whether the district's pages send usage events to the analytics
 * service its deployment names. Off until an administrator turns it on, which is audited. The card
 * says what is sent and what never is, because that is what a privacy review asks.
 */
export const ProductAnalyticsCard = () => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const setting = useLoad("productAnalytics", (c) => c.call("admin.productAnalytics"));
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string>();

  const change = async (enabled: boolean) => {
    setSaving(true);
    setRefusal(undefined);
    try {
      await client.call("admin.setProductAnalytics", { body: { enabled } });
      announce(enabled ? "Product analytics is on." : "Product analytics is off.");
      setting.reload();
    } catch (error) {
      const message = errorMessage(error);
      setRefusal(message);
      announce(`Product analytics was not changed. ${message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <LayerCard className="flex flex-col gap-3 p-4">
      <Text as="h3" variant="secondary">Product analytics</Text>
      <LoadState loaded={setting} what="the product analytics setting" onRetry={setting.reload}>
        {({ configured, enabled, changedAt }) => (
          <>
            <Text>
              When on, every page in this district counts a visit: which app and which screen, and whether the visitor is a
              student, teacher, administrator or family member. It never sends a name, an id, what anyone wrote, the page
              title or the address of a record, stores nothing on the device, records no sessions, and sends nothing from a
              browser that asks not to be tracked.
            </Text>
            <Banner
              variant="alert"
              icon={<Warning weight="fill" />}
              title="Turn this on only after your district's student-privacy review approves it."
              description="Students' visits are counted too. Your privacy notice should say so before it is on."
            />
            <Switch
              label="Count visits to this district's pages"
              checked={enabled}
              disabled={!configured || saving}
              transitioning={saving}
              onClick={() => void change(!enabled)}
            />
            <Text variant="secondary">
              {!configured
                ? "This deployment has no analytics service, so it cannot be turned on."
                : changedOn(changedAt) === undefined
                  ? "Off since the district was set up."
                  : `${enabled ? "Turned on" : "Turned off"} on ${changedOn(changedAt)}.`}
            </Text>
            {refusal !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="Product analytics was not changed." description={refusal} />}
          </>
        )}
      </LoadState>
    </LayerCard>
  );
};
