import { useState } from "react";
import { Banner, Button, Input, Radio, Text } from "@cloudflare/kumo";
import { CheckCircle } from "@phosphor-icons/react";
import type { PolicySettings } from "@schoolos/contracts";
import { ConfirmDialog } from "../app/ConfirmDialog.tsx";
import { LoadState } from "../app/LoadState.tsx";
import type { ConfigVersion, DistrictConfigState } from "../app/useDistrictConfig.ts";
import { documentFromDesired, withDistrictPolicies } from "../configDocument.ts";
import { ChangeReview, type ProposedChange } from "../modules/ChangeReview.tsx";
import { ENUMERATED_POLICIES, MONTHLY_CAP, formatCents, loosenedSettings, type LoosenedSetting } from "./policySettings.ts";

interface PolicyFormProps {
  /** The version in force. Remount with a `key` when it changes. */
  head: ConfigVersion;
  /** The district floor in force. */
  current: PolicySettings;
  /** Called with the change to preview. */
  onPreview: (change: ProposedChange) => void;
}

const PolicyForm = ({ head, current, onPreview }: PolicyFormProps) => {
  const [draft, setDraft] = useState(current);
  const [capDollars, setCapDollars] = useState((current.aiMonthlyCapCentsPerPrincipal / 100).toFixed(2));
  const [confirming, setConfirming] = useState<LoosenedSetting[]>();

  const capCents = Math.round(Number(capDollars) * 100);
  const capValid = capDollars.trim() !== "" && Number.isFinite(capCents) && capCents >= 0;
  const next: PolicySettings = { ...draft, aiMonthlyCapCentsPerPrincipal: capValid ? capCents : current.aiMonthlyCapCentsPerPrincipal };
  const changed = (Object.keys(next) as (keyof PolicySettings)[]).some((key) => next[key] !== current[key]);

  const preview = () => onPreview({
    title: "Preview: district policy change",
    document: documentFromDesired(withDistrictPolicies(head.desired, next)),
    applyLabel: "Apply policy",
  });
  const review = () => {
    const loosened = loosenedSettings(current, next);
    if (loosened.length > 0) setConfirming(loosened);
    else preview();
  };

  return (
    <form className="flex flex-col gap-6" onSubmit={(event) => { event.preventDefault(); review(); }}>
      {ENUMERATED_POLICIES.map((policy) => (
        <div key={policy.key} className="flex flex-col gap-2 rounded-md border border-kumo-line p-4">
          <Radio.Group
            legend={policy.label}
            description={policy.explanation}
            value={draft[policy.key]}
            onValueChange={(value) => setDraft({ ...draft, [policy.key]: value })}
          >
            {policy.choices.map((choice) => (
              <Radio.Item key={choice.value} value={choice.value} label={`${choice.label}: ${choice.explanation}`} />
            ))}
          </Radio.Group>
        </div>
      ))}
      <div className="flex max-w-sm flex-col gap-2 rounded-md border border-kumo-line p-4">
        <Input
          label={`${MONTHLY_CAP.label} (US dollars)`}
          description={`${MONTHLY_CAP.explanation} Now ${formatCents(current.aiMonthlyCapCentsPerPrincipal)}.`}
          inputMode="decimal"
          value={capDollars}
          onChange={(event) => setCapDollars(event.target.value)}
          error={capValid ? undefined : "Enter an amount of zero or more, such as 2.00."}
        />
      </div>
      <div>
        <Button type="submit" variant="primary" disabled={!changed || !capValid}>Review change</Button>
      </div>

      <ConfirmDialog
        open={confirming !== undefined}
        title="Loosen district policy?"
        confirmLabel="Confirm district-level change"
        onCancel={() => setConfirming(undefined)}
        onConfirm={() => { setConfirming(undefined); preview(); }}
      >
        <p>This is a district-level change. It makes these settings less strict for every school and class in the district:</p>
        <ul className="list-disc pl-5">
          {confirming?.map((s) => <li key={s.key}>{s.label}: from {s.from} to {s.to}</li>)}
        </ul>
        <p>You will see a preview of every class it reaches before anything changes.</p>
      </ConfirmDialog>
    </form>
  );
};

/**
 * The district policy floor: AI spending and the per-person cap, prompt logging, personal
 * conversation privacy, teacher observation and social-emotional profiling. Schools and classes
 * can only be stricter than these. Loosening any of them asks for an explicit district-level
 * confirmation before the preview.
 */
export const PoliciesPage = ({ state }: { state: DistrictConfigState }) => {
  const [review, setReview] = useState<ProposedChange>();
  const [notice, setNotice] = useState<string>();
  return (
    <div className="flex flex-col gap-6">
      <Text as="h2" variant="heading" size="lg">Policies</Text>
      <Text variant="secondary">These are the district's settings. Schools and classes can be stricter, never less strict.</Text>
      {notice !== undefined && <Banner icon={<CheckCircle weight="fill" />} title={notice} />}
      <LoadState loaded={state.config} what="the district policies">
        {(config) => {
          if (config.head === undefined) return <Text>Set up the district under Modules and activation first.</Text>;
          const head = config.head;
          if (review !== undefined) {
            return (
              <ChangeReview
                change={review}
                expectedHeadRevisionId={head.revision.id}
                onCancel={() => setReview(undefined)}
                onApplied={(revision, changes) => {
                  state.onApplied(revision, changes);
                  setNotice("The district policy was updated.");
                  setReview(undefined);
                }}
              />
            );
          }
          return <PolicyForm key={head.revision.id} head={head} current={head.desired.policies} onPreview={(change) => { setNotice(undefined); setReview(change); }} />;
        }}
      </LoadState>
    </div>
  );
};
