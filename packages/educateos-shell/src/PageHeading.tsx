import { Text } from "@cloudflare/kumo";
import { documentTitle, useScreenTitle } from "./pageTitle.ts";

/**
 * Focuses an element as it mounts. Module-level, so React sees one ref callback and focuses only
 * when a new element mounts, not on every render.
 */
export const focusOnMount = (element: HTMLElement | null): void => element?.focus();

export interface PageHeadingProps {
  /** The heading's text. */
  children: string;
  /** The app's name, which ends the document title: "Learning Home", "Teacher Studio". */
  app: string;
  /**
   * The screen's name in the document title, where the heading alone would not name it well: a
   * greeting ("Hi, Ava" is the Home screen) or a title that needs its class beside it.
   */
  title?: string;
  /** The heading's id, for a region it labels. */
  id?: string;
}

/**
 * A screen's title. It takes focus when the screen opens, so keyboard and screen-reader users land
 * at the top of the new screen instead of on the link they just followed, and it names the screen in
 * the document title ("My grades · Learning Home", WCAG 2.4.2).
 */
export const PageHeading = ({ children, app, title, id }: PageHeadingProps) => {
  useScreenTitle(documentTitle(title ?? children, app));
  return (
    <h1 id={id} tabIndex={-1} ref={focusOnMount} className="rounded outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand">
      <Text variant="heading" size="lg" as="span">{children}</Text>
    </h1>
  );
};
