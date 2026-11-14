import { PageHeading as ShellPageHeading } from "@educateos/shell";

/** The Learning Home's name, which ends every document title. */
export const APP_NAME = "Learning Home";

/**
 * A screen's title. It takes focus when the screen opens, so keyboard and screen-reader users land
 * at the top of the new screen instead of on the link they just followed, and names the screen in
 * the document title ("My grades · Learning Home").
 */
export const PageHeading = ({ children, title, id }: {
  children: string;
  /** The screen's name in the document title, where the heading alone does not name it well. */
  title?: string;
  /** The heading's id, for a region it labels. */
  id?: string;
}) => (
  <ShellPageHeading app={APP_NAME} {...(title === undefined ? {} : { title })} {...(id === undefined ? {} : { id })}>
    {children}
  </ShellPageHeading>
);
