import { Notice, Section, h, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { CleverNoticeRpc, CleverNoticeValues } from "./clever-notice-types";

// Copied from src/clever-env.ts; __tests__/configurator-urls.test.ts keeps it in step.
const DISTRICT_URL = "https://api.clever.com/district/sections";

// Asked once per frame: the answer only changes when the district changes the user's roles.
let admin: Promise<boolean> | undefined;
let known: boolean | undefined;

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return known === true;
  },

  resourceUrl() {
    if (known !== true) throw new Error("Only a Clever district administrator can connect every section.");
    return DISTRICT_URL;
  },

  render({ ui, setValues }) {
    if (admin === undefined) {
      admin = ui.isDistrictAdmin().catch(() => false);
      void admin.then(value => {
        known = value;
        // Re-render with the answer.
        setValues({ confirmed: value ? "admin" : "not-admin" });
      });
    }
    return <Section>
      {known === false
        ? <Notice tone="error">Only a Clever district administrator can connect every section in the district.</Notice>
        : <Notice>
          Every section in your district, as a teacher reaches one. Each read and change made through it is
          recorded in the district's audit log, under your name.
        </Notice>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<CleverNoticeRpc, CleverNoticeValues>;
