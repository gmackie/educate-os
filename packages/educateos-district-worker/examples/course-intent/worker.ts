// Optional standalone inference Worker. NEVER add a public route or workers.dev URL.
// The district calls it through a private service binding after its own policy
// engine and AI budget governor authorize the teacher's request.
import { serveCourseIntentInference, type CourseIntentAiBinding } from "../../src/course-intent-inference.ts";

export default {
  fetch(request: Request, env: { AI: CourseIntentAiBinding }): Promise<Response> {
    return serveCourseIntentInference(request, env.AI);
  },
};
