import type { ConfiguratorOption } from "./configurator-option";

export type ClassroomStudentCourseConfiguratorValues = { courseId?: string | null };

export interface ClassroomStudentCourseConfiguratorRpc {
  /** List active courses in which the connected account is enrolled as a student. */
  listCourses(query: string): Promise<ConfiguratorOption[]>;
}
