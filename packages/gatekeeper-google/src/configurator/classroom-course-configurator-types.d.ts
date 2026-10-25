import type { ConfiguratorOption } from "./configurator-option";

export type ClassroomCourseConfiguratorValues = {
  courseId?: string | null;
};

export interface ClassroomCourseConfiguratorRpc {
  /** List the active courses the connected account teaches that match the search query. */
  listCourses(query: string): Promise<ConfiguratorOption[]>;
}
