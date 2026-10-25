import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ClassroomCourseConfiguratorRpc, ClassroomCourseConfiguratorValues,
} from "./classroom-course-configurator-types";

export default {
  initial: {},
  isReady: ({ values }) => typeof values.courseId === "string" && values.courseId.length > 0,
  // Must mirror `parseClassroomUrl` in resources.ts, which is what actually mints the capability.
  // This module is transpiled on its own and cannot import that parser, so
  // `__tests__/configurator-url.test.ts` is what keeps the copies honest.
  resourceUrl: ({ values }) =>
    `https://classroom.googleapis.com/courses/${encodeURIComponent(values.courseId ?? "")}`,
  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Course" description="Choose an active course you teach. Only assignments created through this connection can be seen or graded.">
        <Autocomplete
          name="courseId"
          value={values.courseId}
          placeholder="Search your courses..."
          loadOptions={query => ui.listCourses(query)}
          onChange={courseId => setValues({ courseId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ClassroomCourseConfiguratorRpc, ClassroomCourseConfiguratorValues>;
