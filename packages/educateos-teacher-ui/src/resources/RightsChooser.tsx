import { Radio } from "@cloudflare/kumo";
import type { RightsMode } from "../types.ts";
import { RIGHTS_MODES, widens } from "./rightsModes.ts";

/**
 * How the class may use a resource. Narrower modes than `granted` can be chosen; wider ones are
 * shown but disabled, with who can grant them, because a teacher may only narrow rights.
 */
export const RightsChooser = ({ granted, value, onChange, disabled }: {
  granted: RightsMode;
  value: RightsMode;
  onChange: (mode: RightsMode) => void;
  disabled: boolean;
}) => (
  <Radio.Group
    legend="How this class may use it"
    appearance="card"
    value={value}
    disabled={disabled}
    onValueChange={(mode) => onChange(mode as RightsMode)}
  >
    {RIGHTS_MODES.map(({ mode, label, explanation }) => {
      const wider = widens(granted, mode);
      return (
        <Radio.Item
          key={mode}
          value={mode}
          label={label}
          disabled={wider}
          description={wider ? `${explanation} Ask your curriculum admin to allow this.` : explanation}
        />
      );
    })}
  </Radio.Group>
);
