// Page titles (WCAG 2.4.2, SCHO-382). Each SPA on a district origin names the screen it shows in
// the document title, so a screen-reader user switching tabs, or reading history, can tell screens
// apart: "Grades · Learning Home", "Gradebook · English 9 · Teacher Studio".
//
// Two layers set it. The route names itself as soon as the URL changes (`useRouteTitle`, in a
// layout effect), so a screen still loading never keeps the last screen's title; then the screen,
// once it knows what it shows (a class's name, a quiz's title), refines it (`useScreenTitle`, in a
// passive effect). Layout effects run before passive ones in the same commit, so the screen wins.
import { useEffect, useLayoutEffect } from "react";

/** A document title: the screen's own name first, down to the app's name, joined with " · ". */
export const documentTitle = (...parts: readonly string[]): string => parts.filter((part) => part !== "").join(" · ");

/**
 * Sets the title of the route the app is on whenever `route` (the path or hash naming it) changes.
 * Call it once, where the app reads its route.
 */
export const useRouteTitle = (title: string, route: string): void => {
  useLayoutEffect(() => {
    document.title = title;
  }, [title, route]);
};

/**
 * Sets the title of the screen on show, over its route's. It is reasserted on every render, so a
 * route change that keeps the screen mounted (and so reruns `useRouteTitle`) still ends on it.
 * Call it from the screen itself, never from a component that wraps other screens.
 */
export const useScreenTitle = (title: string): void => {
  useEffect(() => {
    document.title = title;
  });
};
