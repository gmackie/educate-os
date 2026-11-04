// The K-12 story tour of Northfield (SCHO-324, SCHO-334): a five-minute walk across the grade bands, one
// screen a step, for a presenter or a visitor. Each step names who to be and where their app opens;
// the screen is the real app over the seeded showcase, found through the district's own API.
import type { DistrictApiClient } from "@educateos/api-client";
import type { DemoDistrict, PersonaId } from "../districts/index.ts";
import { NORTHFIELD_PERSONAS } from "../districts/northfield.ts";

/** One step of the story. */
export interface StoryStep {
  id: string;
  /** The band or audience it shows, such as "K-2" or "Family". */
  band: string;
  /** What happens, as the presenter's one line. */
  title: string;
  /** What to point out on the screen, in a sentence or two. */
  say: string;
  /** Who to be. */
  persona: PersonaId;
  /** Where their app opens, as a hash route, found in the booted district. */
  route: (client: DistrictApiClient) => Promise<string>;
}

const activityRoute = (offeringId: string, title: string) => async (student: DistrictApiClient) => {
  const activity = (await student.call("student.listActivities", { params: { offeringId } })).find((a) => a.assignment.title === title);
  return activity === undefined ? `#/courses/${offeringId}` : `#/courses/${offeringId}/activities/${activity.assignment.id}`;
};

const submissionsRoute = (offeringId: string, title: string) => async (teacher: DistrictApiClient) => {
  const assignment = (await teacher.call("teacher.listAssignments", { params: { offeringId } })).find((a) => a.title === title);
  return assignment === undefined ? `#/classes/${offeringId}/submissions` : `#/classes/${offeringId}/assignments/${assignment.id}`;
};

const fixed = (route: string) => async () => route;

/** The story, youngest first, then the family and the district. */
export const STORY_STEPS: readonly StoryStep[] = [
  {
    id: "k2-student",
    band: "K-2",
    title: "Mateo, grade 1, retells a story by voice and drawing",
    say: "One step a screen, big type, every word read aloud. Mateo listens to “The Little Seed”, records what happened and draws the ending. No typing, no reading required.",
    persona: "k2-student",
    route: activityRoute("off_nf-g1read-fall-r7", "Retell The Little Seed"),
  },
  {
    id: "k2-teacher",
    band: "K-2",
    title: "Mr. Yazzie listens to Priya's retelling",
    say: "Recordings and drawings arrive as submitted work. He scores them on a rubric written for six-year-olds (“Got it!”) and releases feedback that the family sees too.",
    persona: "k2-teacher",
    route: submissionsRoute("off_nf-g1read-fall-r7", "Retell The Little Seed"),
  },
  {
    id: "k2-course",
    band: "K-2",
    title: "Mr. Yazzie's semester, installed from a course package",
    say: "Units 3 to 6 came from Grade 1 Reading Foundations, an Open Course Specification package signed by educateos.io: pages for students, teacher guides and answer keys only teachers see, and every activity assigned. Add a course previews a package before it adds anything.",
    persona: "k2-teacher",
    route: fixed("#/classes/off_nf-g1read-fall-r7/modules"),
  },
  {
    id: "g35-student",
    band: "3-5",
    title: "Abena, grade 4, plans an opinion piece with the Homework Helper",
    say: "Read-aloud on request, and a tutor that gives hints and sentence starters, never answers. The tutor is simulated here; on the live district Hall Monitor screens every message, at grade-4 settings.",
    persona: "g35-student",
    route: activityRoute("off_nf-g4ela-fall-r12", "Should Recess Be Longer?"),
  },
  {
    id: "g68-student",
    band: "6-8",
    title: "Chidi, grade 7, reads feedback on a primary-source analysis",
    say: "Sourcing, context and a claim with evidence from Hammurabi's laws, scored on a four-level rubric, with his teacher's comment released to him and his family.",
    persona: "g68-student",
    route: activityRoute("off_nf-whist7-fall-p4", "What Do Hammurabi's Laws Tell Us?"),
  },
  {
    id: "g68-teacher",
    band: "6-8",
    title: "Mr. Ortega's World History 7 gradebook",
    say: "Every class's gradebook comes from official grades only: rubric scores become a grade when the teacher records or approves it, and quizzes add theirs when released.",
    persona: "g68-teacher",
    route: fixed("#/classes/off_nf-whist7-fall-p4/gradebook"),
  },
  {
    id: "g912-student",
    band: "9-12",
    title: "Amara, grade 9, reads her argument essay's feedback and official grade",
    say: "Released feedback, rubric scores and the official grade, in one place. The Research & Essay Coach (simulated here) coaches her next essay without writing it.",
    persona: "g912-student",
    route: activityRoute("off_nf-eng9-fall-p3", "Should Community Service Be Required to Graduate?"),
  },
  {
    id: "guardian",
    band: "Family",
    title: "Rosa Delgado follows Mateo (grade 1) and Lucía (grade 10)",
    say: "Two children in two schools, one sign-in: classes, due dates, teachers' weekly notes and grades once teachers release them. Nothing a teacher hasn't shared.",
    persona: "guardian",
    route: fixed("#/family"),
  },
  {
    id: "admin",
    band: "District",
    title: "Avery Admin sees every class from kindergarten to grade 12",
    say: "One district, three schools, one console: every class and its roster, learning standards, policies and the AI budget, all on the district's own Cloudflare account.",
    persona: "admin",
    route: fixed("#/classes"),
  },
];

/** Where `step` opens in `district`: its persona's app at its route. */
export async function storyDestination(step: StoryStep, district: DemoDistrict): Promise<{ persona: PersonaId; route: string }> {
  const persona = NORTHFIELD_PERSONAS.find((p) => p.id === step.persona)!;
  return { persona: persona.id, route: await step.route(district.clientFor(persona.subject)) };
}
