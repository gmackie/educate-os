export { bootHarness, type HarnessDistrict } from "./harness.ts";
export {
  DistrictInstance,
  FakeRosterProvider,
  type DistrictHealth,
  type DistrictProviders,
  type RosterProvider,
} from "./district.ts";
export { FakeAiProvider, type FakeUsage, type UsageTotals } from "./fake-ai.ts";
export { FakeIdentityProvider, type IssueOptions, type VerifiedClaims } from "./fake-identity.ts";
export {
  bootDistrictApp,
  DEMO_PAGES,
  demoWeb,
  harnessFetch,
  seedDemo,
  seedDistrict,
  showcaseResourceUrl,
  type DemoPrincipals,
  type SignInAs,
} from "./district-app.ts";
export {
  installSampleCourses,
  loadSampleCourseBundles,
  SAMPLE_COURSE_IDS,
  type InstallSampleCoursesOptions,
  type SampleCourseBundle,
  type SampleCourseInstall,
  type SampleCoursesSummary,
} from "./sample-courses.ts";
export { seedShowcase, type SeedShowcaseOptions, type ShowcaseBandSummary, type ShowcaseSummary } from "./showcase.ts";
export { identityFromBearer } from "./sign-in.ts";
export { MORGAN_LEE_SUBJECT, signInAcrossDistricts, type DistrictSignIn } from "./scenarios.ts";
