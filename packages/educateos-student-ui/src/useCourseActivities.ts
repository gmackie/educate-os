import { useQuery, type Query } from "./api.tsx";
import type { AssignedActivity } from "./model.ts";

/** The activities assigned in one class. */
export const useCourseActivities = (offeringId: string): [Query<AssignedActivity[]>, () => void] =>
  useQuery(`activities:${offeringId}`, (api) => api.call("student.listActivities", { params: { offeringId } }));
