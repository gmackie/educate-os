// Northfield, the demo's first district: the real district application over in-memory stores,
// rostered by OneRoster and seeded with the K-12 showcase (SCHO-322) through its API, as the
// harness seeds a live district. Imports read the harness's synthetic web, and no AI is funded or
// reviewed, so no request ever leaves for a model.
import type { PrincipalId } from "@educateos/contracts";
import { createDistrictApp, inMemoryDistrictStores } from "@educateos/district-app";
import { NORTHFIELD, NORTHFIELD_GUARDIANS, NORTHFIELD_SHOWCASE } from "@educateos/fixtures";
import { demoWeb, seedShowcase, showcaseResourceUrl } from "@educateos/harness";
import { schoolDayDue } from "./schoolDay.ts";
import { clientsOver, personaVerifier, verifySeedRelease, type DemoDistrict, type Persona, type PersonaSection } from "./shared.ts";

/** The district administrator, who approves standards and confirms guardians. */
const ADMIN = "prn_nf-district-admin" as PrincipalId;

/** The picker's sections: one a grade band, then families and the district office. */
export const NORTHFIELD_SECTIONS: readonly PersonaSection[] = [
  { key: "K-2", title: "Kindergarten to grade 2", description: "One step at a time, read aloud, answered by drawing and speaking." },
  { key: "3-5", title: "Grades 3 to 5", description: "Read-aloud on request, and a helper that gives hints and sentence starters, not answers." },
  { key: "6-8", title: "Grades 6 to 8", description: "Primary sources, class discussions and coached drafts." },
  { key: "9-12", title: "Grades 9 to 12", description: "Arguments with evidence, released feedback and official grades." },
  { key: "family", title: "Family", description: "One guardian, two children in two schools." },
  { key: "district", title: "District", description: "The whole K-12 district, from one console." },
];

/**
 * Who a visitor can be in Northfield, in the order the picker offers them: a student and their
 * teacher in each grade band, a guardian and the administrator. Known before the district boots,
 * so the picker shows at once; {@link bootNorthfield} checks each is the fixture's person.
 */
export const NORTHFIELD_PERSONAS: readonly Persona[] = [
  {
    id: "k2-student",
    kind: "student",
    section: "K-2",
    band: "K-2",
    name: "Mateo Delgado",
    role: "Grade 1 student",
    description: "Listen to “The Little Seed”, tell what happened, draw the ending and hand it in.",
    lookFor: "big type, the story read aloud, the drawing pad and the microphone",
    subject: "nf-s-2009",
  },
  {
    id: "k2-teacher",
    kind: "teacher",
    section: "K-2",
    name: "Daniel Yazzie",
    role: "Grade 1 teacher",
    description: "Listen to Priya's retelling, look at her drawing, and release Jonah's feedback on his story problems in Grade 1 Mathematics.",
    lookFor: "recordings and drawings in Submissions, and the Grade 1 gradebook",
    subject: "nf-0105",
  },
  {
    id: "g35-student",
    kind: "student",
    section: "3-5",
    band: "3-5",
    name: "Abena Mensah",
    role: "Grade 4 student",
    description: "Finish your opinion piece on a longer recess, and read your teacher's feedback on the kite story.",
    lookFor: "read-aloud, and the Homework Helper's hints and sentence starters (simulated)",
    subject: "nf-s-2012",
  },
  {
    id: "g35-teacher",
    kind: "teacher",
    section: "3-5",
    name: "Fatima Al-Sayed",
    role: "Grade 4 teacher",
    description: "Grade Hana's theme essay against the rubric and post an announcement to families.",
    lookFor: "rubric scoring, the gradebook, and the weekly note families read",
    subject: "nf-0106",
  },
  {
    id: "g68-student",
    kind: "student",
    section: "6-8",
    band: "6-8",
    name: "Chidi Okafor",
    role: "Grade 7 student",
    description: "Read feedback on Hammurabi's laws, join the class discussion and draft “Ideas on the Move”.",
    lookFor: "a primary-source analysis, a discussion, and the Study Coach (simulated)",
    subject: "nf-s-2002",
  },
  {
    id: "g68-teacher",
    kind: "teacher",
    section: "6-8",
    name: "Tomás Ortega",
    role: "World History 7 teacher",
    description: "Grade Felix's primary-source analysis and answer your class's discussion.",
    lookFor: "source-based work, the discussion and the gradebook",
    subject: "nf-0109",
  },
  {
    id: "g912-student",
    kind: "student",
    section: "9-12",
    band: "9-12",
    name: "Amara Okafor",
    role: "Grade 9 student",
    description: "Read your teacher's feedback and official grade on your argument essay, then plan the next one.",
    lookFor: "released feedback, official grades, and the Research & Essay Coach (simulated)",
    subject: "nf-s-2001",
  },
  {
    id: "g912-teacher",
    kind: "teacher",
    section: "9-12",
    name: "Sam Rivera",
    role: "English 9 teacher",
    description: "Grade Elena's argument essay, release the feedback, and see your class gradebook.",
    lookFor: "rubric grading, released feedback and official grades",
    subject: "nf-0101",
  },
  {
    id: "guardian",
    kind: "guardian",
    section: "family",
    name: "Rosa Delgado",
    role: "Guardian of Mateo (grade 1) and Lucía (grade 10)",
    description: "Follow both children, in two schools, from one place: classes, due dates and released grades.",
    lookFor: "each child's classes, the teacher's weekly note, and grades once released",
    subject: "nf-g-3101",
  },
  {
    id: "admin",
    kind: "admin",
    section: "district",
    name: "Avery Admin",
    role: "District administrator",
    description: "Look over every class from kindergarten to grade 12, its people, policies and settings.",
    lookFor: "All classes, each class's roster, learning standards and policies",
    subject: "nf-0001",
  },
];

/** The district's configuration: rostered from OneRoster files previewed before they apply, with the core modules on for every active class. */
const config = (district: string): Record<string, unknown> => ({
  apiVersion: "educateos.io/v1alpha1",
  district,
  profile: "us-k12-conservative",
  identity: { provider: "district-sso" },
  rostering: { provider: "oneroster-csv", mode: "preview-before-apply" },
  modules: { "core-learning": "enabled", "learning-registry": "enabled", "content-studio": "enabled" },
  rollout: { target: "all-active-offerings", requiresAdminActivation: false },
});

/** How {@link bootNorthfield} serves people other than the demo's own pages. */
export interface NorthfieldOptions {
  /** Turns on the device API and phone pairing (`/api/m`, `/api/pair`, `/connect-phone`). */
  deviceTokenSecret?: string;
  /**
   * The persona subject a request is from when it carries no bearer, such as the mobile dev
   * district's sign-in cookie on its `/connect-phone` page.
   */
  subjectOf?: (request: Request) => string | undefined;
  /** The day the showcase's due dates count from. Today by default. */
  today?: Date;
}

/**
 * Boots Northfield and seeds the K-12 showcase, without funding pools, a model catalog or a content
 * reviewer: AI is off, and every AI surface reports that it is not set up. `fetch` is the district
 * application itself, for serving it over HTTP (the mobile dev district).
 */
export async function bootNorthfield(options: NorthfieldOptions = {}): Promise<DemoDistrict & { fetch(request: Request): Promise<Response> }> {
  const directory = NORTHFIELD;
  const app = await createDistrictApp({
    stores: inMemoryDistrictStores(directory),
    verifyRequest: personaVerifier(directory, options.subjectOf),
    ...(options.deviceTokenSecret === undefined ? {} : { deviceTokenSecret: options.deviceTokenSecret }),
    // Synthetic personas only: publish their discussion posts without Hall Monitor.
    unscreenedStudentPosts: "publish",
    importFetch: demoWeb,
    verifyCatalogRelease: verifySeedRelease,
  });
  const clientFor = clientsOver((request) => app.fetch(request));
  const person = (id: string) => directory.principals.find((p) => p.id === id)!;

  const seeded = await seedShowcase({
    showcase: NORTHFIELD_SHOWCASE,
    adminId: ADMIN,
    actAs: (id) => clientFor(person(id).externalIdentities[0]!.subject),
    guardians: NORTHFIELD_GUARDIANS,
    guardianNames: Object.fromEntries(NORTHFIELD_GUARDIANS.map((g) => [g.guardianPrincipalId, person(g.guardianPrincipalId).displayName])),
    resourceUrl: showcaseResourceUrl,
    dueAt: schoolDayDue(options.today ?? new Date()),
  });
  if (seeded.skipped.length > 0) throw new Error(`the showcase left out ${seeded.skipped.join(", ")}`);
  // A live district runs under a configuration its administrator applied. Without one, the admin
  // console reads "not set up" on its dashboard, roster integration and policies.
  await clientFor(person(ADMIN).externalIdentities[0]!.subject).call("admin.applyConfig", { body: { document: config(directory.district.id), acknowledgeApprovals: true } });

  for (const persona of NORTHFIELD_PERSONAS) {
    const principal = directory.principals.find((p) => p.externalIdentities.some((i) => i.subject === persona.subject));
    if (principal?.displayName !== persona.name) throw new Error(`the demo's ${persona.id} is not ${persona.name}`);
  }
  return { key: "northfield", clientFor, fetch: (request) => app.fetch(request) };
}
