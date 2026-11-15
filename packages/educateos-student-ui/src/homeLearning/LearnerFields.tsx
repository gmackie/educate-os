import { Input, Radio } from "@cloudflare/kumo";
import { AVATARS, GRADE_BANDS } from "./labels.ts";

/** A child's profile as a form edits it. */
export interface LearnerDraft {
  displayName: string;
  avatar: string;
  gradeBand: "K" | "1" | "2";
}

/** An empty profile. */
export const NEW_LEARNER: LearnerDraft = { displayName: "", avatar: AVATARS[0][0], gradeBand: "K" };

/**
 * A child's name, picture and starting grade. Only what practice needs: no birth date, school or
 * photo. The grade only chooses where each track starts.
 */
export const LearnerFields = ({ idPrefix, value, onChange }: { idPrefix: string; value: LearnerDraft; onChange: (next: LearnerDraft) => void }) => (
  <div className="flex flex-col gap-4">
    <Input
      label="Child's first name or nickname"
      description="Shown to your child and on your pages. Nothing else about them is needed."
      maxLength={40}
      value={value.displayName}
      onChange={(event) => onChange({ ...value, displayName: event.target.value })}
    />
    <Radio.Group legend="Their picture" orientation="horizontal" value={value.avatar} onValueChange={(avatar) => onChange({ ...value, avatar: String(avatar) })} className="flex flex-wrap gap-2">
      {AVATARS.map(([emoji, name]) => <Radio.Item key={`${idPrefix}-${emoji}`} value={emoji} label={`${emoji} ${name}`} />)}
    </Radio.Group>
    <Radio.Group
      legend="Where to start"
      description="A starting point for reading and math. You can change either one later."
      value={value.gradeBand}
      onValueChange={(band) => onChange({ ...value, gradeBand: band as LearnerDraft["gradeBand"] })}
    >
      {GRADE_BANDS.map((band) => <Radio.Item key={`${idPrefix}-${band.value}`} value={band.value} label={band.label} />)}
    </Radio.Group>
  </div>
);
