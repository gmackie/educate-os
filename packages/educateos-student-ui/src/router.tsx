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

const isFamilyPath = (pathname: string) => pathname === "/family" || pathname.startsWith("/family/");

/**
 * The signed-in frame. Who the principal is decides which places exist: a guardian has only the
 * family view and is taken there from anywhere else, and the family view does not exist for a
 * student. The district refuses each the other's routes too; this keeps either from being offered.
 */
const SignedIn = ({ pathname }: { pathname: string }) => {
  const [me] = useQuery("me", (api) => api.call("me.get"));
  const audience = me.status === "ready" ? (me.data.kind === "guardian" ? "family" : "student") : undefined;
  const unlinked = me.status === "error" ? unlinkedSignInOf(me.error) : undefined;
  const content = me.status === "loading" ? (
    <LoadingSkeleton label="Opening your Learning Home" />
  ) : unlinked !== undefined ? (
    <NotAddedYet signIn={unlinked} />
  ) : me.status === "error" ? (
    <ErrorState error={me.error} title="We couldn't open your Learning Home" />
  ) : audience === "family" && !isFamilyPath(pathname) ? (
    <Navigate to={pathname === "/settings" ? FAMILY_SETTINGS_PATH : "/family"} replace />
  ) : audience === "student" && isFamilyPath(pathname) ? (
    <Empty title="There's nothing here" description="Use Home to find your classes." />
  ) : (
    <Outlet />
  );
  return <Layout studentName={me.status === "ready" ? me.data.displayName : undefined} audience={audience}>{content}</Layout>;
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

const routeTree = rootRoute.addChildren([homeRoute, mySpaceRoute, gradesRoute, calendarRoute, notificationsRoute, settingsRoute, courseRoute, activityRoute, quizRoute, quizResultRoute, familyRoute, familySettingsRoute, invitationRoute, childRoute, childCourseRoute]);

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

/**
 * What every Kumo link renders through: in-app paths go through the router, so following one keeps
 * the page (and any unsaved typing in other tabs' drafts) instead of reloading; absolute URLs stay
 * plain anchors.
 */
export const AppLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(({ href = "", ...rest }, ref) =>
  /^[a-z][a-z0-9+.-]*:/i.test(href) ? <a ref={ref} href={href} {...rest} /> : <RouterLink ref={ref} to={href} activeOptions={{ exact: true }} {...rest} />,
);
AppLink.displayName = "AppLink";
