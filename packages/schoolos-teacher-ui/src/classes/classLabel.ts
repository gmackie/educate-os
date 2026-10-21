import type { TeachingOffering } from "../types.ts";

/** How a class is named on screen: its course and section, such as "English 9 · Period 3". */
export const classLabel = ({ course, offering }: TeachingOffering): string => `${course.title} · ${offering.sectionName}`;
