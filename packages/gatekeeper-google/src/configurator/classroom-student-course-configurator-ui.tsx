import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ClassroomStudentCourseConfiguratorRpc, ClassroomStudentCourseConfiguratorValues,
} from "./classroom-student-course-configurator-types";

export default {
  initial: {},
  isReady: ({ values }) => typeof values.courseId === "string" && /^\d{1,32}$/.test(values.courseId),
  initialValuesFromResourceUrl: ({ resourceUrl }) => ({
    courseId: /^\/student-courses\/(\d+)$/.exec(new URL(resourceUrl).pathname)?.[1] ?? null,
  }),
  resourceUrl: ({ values }) =>
    `https://classroom.googleapis.com/student-courses/${encodeURIComponent(values.courseId ?? "")}`,
  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Your course" description="Choose a course where this Google account is enrolled as a student. This private connection shows published work and your own submission only.">
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
} satisfies ConfiguratorUISpec<ClassroomStudentCourseConfiguratorRpc, ClassroomStudentCourseConfiguratorValues>;
