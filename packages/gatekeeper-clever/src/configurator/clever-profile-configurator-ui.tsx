import { Notice, Section, h, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { CleverNoticeRpc, CleverNoticeValues } from "./clever-notice-types";

// Copied from src/clever-env.ts; __tests__/configurator-urls.test.ts keeps it in step.
const PROFILE_URL = "https://api.clever.com/me";

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl() {
    return PROFILE_URL;
  },

  render() {
    return <Section>
      <Notice>Who you are in Clever: your name, roles, district and schools. Nothing else is read.</Notice>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CleverNoticeRpc, CleverNoticeValues>;
