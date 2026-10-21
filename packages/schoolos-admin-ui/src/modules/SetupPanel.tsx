import { useState } from "react";
import { Button, Radio, Text } from "@cloudflare/kumo";
import type { DistrictId } from "@schoolos/contracts";
import { CONFIG_API_VERSION, type ConfigDocument } from "../configDocument.ts";
import type { ProposedChange } from "./ChangeReview.tsx";

const PROFILES = [
  { value: "us-k12-conservative", label: "Conservative", explanation: "AI is capped low and teachers see assigned work only." },
  { value: "us-k12-standard", label: "Standard", explanation: "A higher AI cap, and teachers also see conversations students share with them." },
] as const;

/**
 * The district's first configuration: a defaults profile with every module off and nothing
 * visible to any class, so setup cannot expose anything before the administrator rolls it out.
 */
export function firstConfiguration(districtId: DistrictId, profile: string): ConfigDocument {
  return {
    apiVersion: CONFIG_API_VERSION,
    district: districtId,
    profile,
    identity: { provider: "district-sso" },
    rostering: { provider: "oneroster-csv", mode: "preview-before-apply" },
    modules: { "core-learning": "disabled" },
    rollout: { target: "all-active-offerings", requiresAdminActivation: true },
  };
}

/** Starts the district's configuration when it has none. */
export const SetupPanel = ({ districtId, onPreview }: { districtId: DistrictId; onPreview: (change: ProposedChange) => void }) => {
  const [profile, setProfile] = useState<string>(PROFILES[0].value);
  return (
    <section aria-labelledby="setup-heading" className="flex flex-col gap-3">
      <Text as="h3" variant="heading" id="setup-heading">Set up the district</Text>
      <Text>The district has no configuration yet. Choose the defaults to start from; every module starts off and no class sees anything until you roll it out.</Text>
      <Radio.Group legend="District defaults" value={profile} onValueChange={(value) => setProfile(value as string)}>
        {PROFILES.map((p) => <Radio.Item key={p.value} value={p.value} label={`${p.label}: ${p.explanation}`} />)}
      </Radio.Group>
      <div>
        <Button variant="primary" onClick={() => onPreview({ title: "Preview: start the district configuration", document: firstConfiguration(districtId, profile), applyLabel: "Create configuration" })}>
          Preview setup
        </Button>
      </div>
    </section>
  );
};
