import { forwardRef, type AnchorHTMLAttributes } from "react";
import { Empty } from "@cloudflare/kumo";
import {
  Link as RouterLink,
  Navigate,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
  type RouterHistory,
} from "@tanstack/react-router";
import { unlinkedSignInOf } from "@educateos/api-client";
import { useQuery } from "./api.tsx";
import { ActivityPage } from "./activity/ActivityPage.tsx";
import { CoursePage } from "./CoursePage.tsx";
import { ErrorState } from "./ErrorState.tsx";
import { GradesPage } from "./GradesPage.tsx";
import { HomePage } from "./HomePage.tsx";
import { Layout } from "./Layout.tsx";
import { LoadingSkeleton } from "./LoadingSkeleton.tsx";
import { MySpacePage } from "./MySpacePage.tsx";
import { NotAddedYet } from "./NotAddedYet.tsx";
import { useDistrictShell } from "./shell.tsx";
import { ShellLayout } from "./ShellLayout.tsx";
// Your devices and Connect phone (SCHO-260)
import { ConnectPhonePage } from "./devices/ConnectPhonePage.tsx";
import { DevicesPage } from "./devices/DevicesPage.tsx";
import { CONNECT_PHONE_PATH, DEVICES_PATH } from "./devices/paths.ts";
// Family view (ADR-0012, SCHO-188)
import { ChildCoursePage } from "./family/ChildCoursePage.tsx";
import { ChildPage } from "./family/ChildPage.tsx";
import { FamilyHomePage } from "./family/FamilyHomePage.tsx";
import { FamilySettingsPage } from "./family/FamilySettingsPage.tsx";
import { InvitationPage } from "./family/InvitationPage.tsx";
// Communication (SCHO-189)
import { CalendarPage } from "./communication/CalendarPage.tsx";
import { NotificationsPage } from "./communication/NotificationsPage.tsx";
import { SettingsPage } from "./communication/SettingsPage.tsx";
// Quizzes (SCHO-191)
import { QuizPage } from "./quizzes/QuizPage.tsx";
import { QuizResultPage } from "./quizzes/QuizResultPage.tsx";

/** Where a guardian's invitation link opens. It is the one page that needs no EducateOS account. */
export const INVITATION_PATH = "/family/invitation";

/** A guardian's settings (SCHO-222). A guardian is taken there from a student's `/settings`. */
export const FAMILY_SETTINGS_PATH = "/family/settings";

export { CONNECT_PHONE_PATH, DEVICES_PATH };

/** Whether `pathname` is the family view's. */
export const isFamilyPath = (pathname: string): boolean => pathname === "/family" || pathname.startsWith("/family/");

/** Whether `pathname` is a page every role has, which no audience is taken away from. */
const isSharedPath = (pathname: string) => pathname === DEVICES_PATH || pathname.startsWith(`${DEVICES_PATH}/`);

/**
 * The signed-in frame. Who the principal is decides which places exist: a guardian has only the
 * family view and is taken there from anywhere else, and the family view does not exist for a
 * student. The district refuses each the other's routes too; this keeps either from being offered.
 */
const SignedIn = ({ pathname }: { pathname: string }) => {
  const [me] = useQuery("me", (api) => api.call("me.get"));
  const audience = me.status === "ready" ? (me.data.kind === "guardian" ? "family" : "student") : undefined;
  const unlinked = me.status === "error" ? unlinkedSignInOf(me.error) : undefined;
  const shared = isSharedPath(pathname);
  const content = me.status === "loading" ? (
    <LoadingSkeleton label="Opening your Learning Home" />
  ) : unlinked !== undefined ? (
    <NotAddedYet signIn={unlinked} />
  ) : me.status === "error" ? (
    <ErrorState error={me.error} title="We couldn't open your Learning Home" />
  ) : audience === "family" && !isFamilyPath(pathname) && !shared ? (
    <Navigate to={pathname === "/settings" ? FAMILY_SETTINGS_PATH : "/family"} replace />
  ) : audience === "student" && isFamilyPath(pathname) ? (
    <Empty title="There's nothing here" description="Use Home to find your classes." />
  ) : (
    <Outlet />
  );
  const shell = useDistrictShell();
  return shell === undefined ? (
    <Layout studentName={me.status === "ready" ? me.data.displayName : undefined} audience={audience}>{content}</Layout>
  ) : (
    <ShellLayout shell={shell} me={me.status === "ready" ? me.data : undefined} audience={audience}>{content}</ShellLayout>
  );
};

const Root = () => {
  // The location the rendered matches belong to: during a navigation `location` already names the
  // next page while the previous one is still what an outlet would render.
  const pathname = useRouterState({ select: (state) => (state.resolvedLocation ?? state.location).pathname });
  return pathname === INVITATION_PATH ? <Layout studentName={undefined} audience={undefined}><Outlet /></Layout> : <SignedIn pathname={pathname} />;
};

const rootRoute = createRootRoute({
  component: Root,
  notFoundComponent: () => <Empty title="There's nothing here" description="Use Home to find your classes." />,
});

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });

const mySpaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/my-space", component: MySpacePage });

const gradesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/grades", component: GradesPage });

const calendarRoute = createRoute({ getParentRoute: () => rootRoute, path: "/calendar", component: () => <CalendarPage /> });

const notificationsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/notifications", component: NotificationsPage });

const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: () => <SettingsPage /> });

const courseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/courses/$offeringId",
  component: () => {
    const { offeringId } = courseRoute.useParams();
    return <CoursePage key={offeringId} offeringId={offeringId} />;
  },
});

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/courses/$offeringId/activities/$assignmentId",
  component: () => {
    const { offeringId, assignmentId } = activityRoute.useParams();
    return <ActivityPage key={assignmentId} offeringId={offeringId} assignmentId={assignmentId} />;
  },
});

// Quizzes (SCHO-191)
const quizRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/courses/$offeringId/quizzes/$quizId",
  component: () => {
    const { offeringId, quizId } = quizRoute.useParams();
    return <QuizPage key={quizId} offeringId={offeringId} quizId={quizId} />;
  },
});

const quizResultRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/courses/$offeringId/quizzes/$quizId/attempts/$attemptId",
  component: () => {
    const { offeringId, quizId, attemptId } = quizResultRoute.useParams();
    return <QuizResultPage key={attemptId} offeringId={offeringId} quizId={quizId} attemptId={attemptId} />;
  },
});

// Family view (ADR-0012, SCHO-188)
const familyRoute = createRoute({ getParentRoute: () => rootRoute, path: "/family", component: FamilyHomePage });

const familySettingsRoute = createRoute({ getParentRoute: () => rootRoute, path: FAMILY_SETTINGS_PATH, component: FamilySettingsPage });

const invitationRoute = createRoute({ getParentRoute: () => rootRoute, path: INVITATION_PATH, component: InvitationPage });

const childRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/family/children/$studentId",
  component: () => {
    const { studentId } = childRoute.useParams();
    return <ChildPage key={studentId} studentId={studentId} />;
  },
});

const childCourseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/family/children/$studentId/courses/$offeringId",
  component: () => {
    const { studentId, offeringId } = childCourseRoute.useParams();
    return <ChildCoursePage key={`${studentId}:${offeringId}`} studentId={studentId} offeringId={offeringId} />;
  },
});

// Your devices and Connect phone (SCHO-260)
const devicesRoute = createRoute({ getParentRoute: () => rootRoute, path: DEVICES_PATH, component: DevicesPage });

const connectPhoneRoute = createRoute({ getParentRoute: () => rootRoute, path: CONNECT_PHONE_PATH, component: ConnectPhonePage });

const routeTree = rootRoute.addChildren([homeRoute, mySpaceRoute, gradesRoute, calendarRoute, notificationsRoute, settingsRoute, courseRoute, activityRoute, quizRoute, quizResultRoute, familyRoute, familySettingsRoute, invitationRoute, childRoute, childCourseRoute, devicesRoute, connectPhoneRoute]);

/** The Learning Home's router: on the browser's history, or on a memory history in tests. */
export const createStudentRouter = (history?: RouterHistory) =>
  createRouter({ routeTree, ...(history === undefined ? {} : { history }), scrollRestoration: true });

/** The path of a course's screen. */
export const coursePath = (offeringId: string): string => `/courses/${encodeURIComponent(offeringId)}`;

/** The path of an activity's screen. */
export const activityPath = (offeringId: string, assignmentId: string): string =>
  `${coursePath(offeringId)}/activities/${encodeURIComponent(assignmentId)}`;

/** The path of a quiz's screen (SCHO-191). */
export const quizPath = (offeringId: string, quizId: string): string => `${coursePath(offeringId)}/quizzes/${encodeURIComponent(quizId)}`;

/** The path of one finished attempt's results (SCHO-191). */
export const quizResultPath = (offeringId: string, quizId: string, attemptId: string): string =>
  `${quizPath(offeringId, quizId)}/attempts/${encodeURIComponent(attemptId)}`;

/** The path of a guardian's child's screen. */
export const childPath = (studentId: string): string => `/family/children/${encodeURIComponent(studentId)}`;

/** The path of one of a guardian's child's classes. */
export const childCoursePath = (studentId: string, offeringId: string): string =>
  `${childPath(studentId)}/courses/${encodeURIComponent(offeringId)}`;

/** The first path segments this SPA routes. Anything else on the origin is another app's. */
const OWN_SEGMENTS = new Set(["", "courses", "my-space", "grades", "calendar", "notifications", "settings", "family", "devices"]);

/** Whether `href` is a path this SPA routes, rather than a URL or another app on the origin (/teach, /admin, /ai). */
export const isAppPath = (href: string): boolean =>
  href.startsWith("/") && !href.startsWith("//") && OWN_SEGMENTS.has(href.slice(1).split(/[/?#]/, 1)[0]!);

/**
 * What every Kumo link renders through: in-app paths go through the router, so following one keeps
 * the page (and any unsaved typing in other tabs' drafts) instead of reloading; absolute URLs and
 * the other apps on the district origin (Teacher Studio, the admin console, the AI workspace) stay
 * plain anchors, which load them.
 */
export const AppLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string }>(({ href = "", to, ...rest }, ref) => {
  // Some Kumo parts (Breadcrumbs) name the destination `to`, with an empty `href`.
  const target = href === "" && to !== undefined ? to : href;
  if (!isAppPath(target)) return <a ref={ref} href={target} {...rest} />;
  const [path = "/", hash] = target.split("#", 2);
  return <RouterLink ref={ref} to={path} {...(hash === undefined ? {} : { hash })} activeOptions={{ exact: true }} {...rest} />;
});
AppLink.displayName = "AppLink";
