import { forwardRef, type AnchorHTMLAttributes } from "react";
import { Empty } from "@cloudflare/kumo";
import {
  Link as RouterLink,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { useQuery } from "./api.tsx";
import { ActivityPage } from "./activity/ActivityPage.tsx";
import { CoursePage } from "./CoursePage.tsx";
import { ErrorState } from "./ErrorState.tsx";
import { GradesPage } from "./GradesPage.tsx";
import { HomePage } from "./HomePage.tsx";
import { Layout } from "./Layout.tsx";
import { MySpacePage } from "./MySpacePage.tsx";

const Root = () => {
  const [me] = useQuery("me", (api) => api.call("me.get"));
  return (
    <Layout studentName={me.status === "ready" ? me.data.displayName : undefined}>
      {me.status === "error" ? <ErrorState error={me.error} title="We couldn't open your Learning Home" /> : <Outlet />}
    </Layout>
  );
};

const rootRoute = createRootRoute({
  component: Root,
  notFoundComponent: () => <Empty title="There's nothing here" description="Use Home to find your classes." />,
});

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });

const mySpaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/my-space", component: MySpacePage });

const gradesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/grades", component: GradesPage });

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

const routeTree = rootRoute.addChildren([homeRoute, mySpaceRoute, gradesRoute, courseRoute, activityRoute]);

/** The Learning Home's router: on the browser's history, or on a memory history in tests. */
export const createStudentRouter = (history?: RouterHistory) =>
  createRouter({ routeTree, ...(history === undefined ? {} : { history }), scrollRestoration: true });

/** The path of a course's screen. */
export const coursePath = (offeringId: string): string => `/courses/${encodeURIComponent(offeringId)}`;

/** The path of an activity's screen. */
export const activityPath = (offeringId: string, assignmentId: string): string =>
  `${coursePath(offeringId)}/activities/${encodeURIComponent(assignmentId)}`;

/**
 * What every Kumo link renders through: in-app paths go through the router, so following one keeps
 * the page (and any unsaved typing in other tabs' drafts) instead of reloading; absolute URLs stay
 * plain anchors.
 */
export const AppLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(({ href = "", ...rest }, ref) =>
  /^[a-z][a-z0-9+.-]*:/i.test(href) ? <a ref={ref} href={href} {...rest} /> : <RouterLink ref={ref} to={href} activeOptions={{ exact: true }} {...rest} />,
);
AppLink.displayName = "AppLink";
