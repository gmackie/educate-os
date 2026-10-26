import { useQuery } from "./api.tsx";
import { classTitleIn } from "./labels.ts";

/**
 * The name of one of the student's classes, such as "Earth Science · Tuesday mornings", for a
 * screen whose own data names only the course. `fallback` stands in while it loads or if it can't.
 */
export const useClassTitle = (offeringId: string, fallback: string): string => {
  const [offerings] = useQuery("offerings", (api) => api.call("student.listOfferings"));
  return offerings.status === "ready" ? classTitleIn(offerings.data, offeringId) : fallback;
};
