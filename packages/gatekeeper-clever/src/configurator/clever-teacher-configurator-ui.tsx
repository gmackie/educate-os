import {
  HierarchyPicker, Notice, Section, h, type ConfiguratorUIHostContext, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type { CleverSectionPickerRpc, CleverSectionPickerValues } from "./clever-section-picker-types";

// Copied from src/clever-env.ts, which this module cannot import; __tests__/configurator-urls.test.ts
// keeps the copies in step.
const ALL_PATTERN = "https://api.clever.com/me/sections";
const ONE_PATTERN = "https://api.clever.com/sections/:sectionId";
const ONE_PREFIX = "https://api.clever.com/sections/";
const CLEVER_ID = /^[0-9a-f]{24}$/;

/** The root's id: every section. */
const ALL = "all";

function accepts(context: ConfiguratorUIHostContext, pattern: string): boolean {
  return context.acceptedResourceUrlPatterns === undefined || context.acceptedResourceUrlPatterns.includes(pattern);
}

function chosen(target: string | null | undefined, context: ConfiguratorUIHostContext): string | undefined {
  if (target === ALL && accepts(context, ALL_PATTERN)) return ALL_PATTERN;
  if (CLEVER_ID.test(target ?? "") && accepts(context, ONE_PATTERN)) return `${ONE_PREFIX}${target}`;
  return undefined;
}

export default {
  initial: {},

  initialValuesFromResourceUrl({ resourceUrl }) {
    const url = resourceUrl.replace(/\/+$/, "");
    if (url === ALL_PATTERN) return { target: ALL };
    if (url.startsWith(ONE_PREFIX) && CLEVER_ID.test(url.slice(ONE_PREFIX.length))) {
      return { target: url.slice(ONE_PREFIX.length) };
    }
    return {};
  },

  isReady(context) {
    return chosen(context.values.target, context) !== undefined;
  },

  resourceUrl(context) {
    const url = chosen(context.values.target, context);
    if (url === undefined) throw new Error("Choose every section, or one section.");
    return url;
  },

  render(context) {
    const { values, setValues, ui } = context;
    const one = accepts(context, ONE_PATTERN);
    return <Section>
      <HierarchyPicker
        name="target"
        value={values.target}
        root={{ id: ALL, title: "Sections you teach", selectable: accepts(context, ALL_PATTERN), subtitle: "Every section you teach, including ones added later." }}
        searchPlaceholder="Search your sections"
        loadItems={async ({ query }) => {
          const needle = query.trim().toLowerCase();
          const sections = (await ui.listSections())
            .filter(section => needle === "" || section.title.toLowerCase().includes(needle));
          return {
            items: sections.map(section => ({
              id: section.id, title: section.title, kind: "leaf" as const, selectable: one,
              ...(section.subtitle === undefined ? {} : { subtitle: section.subtitle }),
            })),
          };
        }}
        loadItem={async id => {
          const section = await ui.getSection(id);
          return section === null ? null : { id: section.id, title: section.title, kind: "leaf" as const, path: [] };
        }}
        onChange={target => setValues({ target })}
      />
      <Notice>Rosters show names and grade levels only. Assignments and grades go to each section's learning management system once you approve them.</Notice>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CleverSectionPickerRpc, CleverSectionPickerValues>;
