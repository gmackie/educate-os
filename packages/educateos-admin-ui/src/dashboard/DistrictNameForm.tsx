import { useState } from "react";
import { Banner, Button, Input, LayerCard, Text } from "@cloudflare/kumo";
import { CheckCircle, Warning } from "@phosphor-icons/react";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { errorMessage } from "../app/useLoad.ts";

const MAX_NAME = 120;

type Outcome = { kind: "renamed"; name: string } | { kind: "refused"; message: string };

/**
 * Renames the district (SCHO-344): the name every screen, the phone app and the calendar feed
 * show. Screens that already loaded the old name show the new one when they next load.
 */
export const DistrictNameForm = ({ name, onRenamed }: { name: string; onRenamed: () => void }) => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const next = draft.trim();

  const rename = async () => {
    setSaving(true);
    try {
      const district = await client.call("admin.renameDistrict", { body: { name: next } });
      setOutcome({ kind: "renamed", name: district.name });
      announce(`The district is now named ${district.name}.`);
      onRenamed();
    } catch (error) {
      const message = errorMessage(error);
      setOutcome({ kind: "refused", message });
      announce(`The district was not renamed. ${message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <LayerCard className="flex flex-col gap-3 p-4">
      <Text as="h3" variant="secondary">District name</Text>
      <form
        aria-label="Rename the district"
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void rename();
        }}
      >
        <Input label="Name" required maxLength={MAX_NAME} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" variant="primary" loading={saving} disabled={next === "" || next === name}>Rename</Button>
      </form>
      {outcome?.kind === "renamed" && (
        <Banner icon={<CheckCircle weight="fill" />} title={`The district is now named ${outcome.name}.`} description="Screens already open show it when they next load." />
      )}
      {outcome?.kind === "refused" && (
        <Banner variant="error" icon={<Warning weight="fill" />} title="The district was not renamed." description={outcome.message} />
      )}
    </LayerCard>
  );
};
