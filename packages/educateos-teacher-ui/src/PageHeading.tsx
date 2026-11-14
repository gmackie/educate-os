import { PageHeading as ShellPageHeading } from "@educateos/shell";

/** Teacher Studio's name, which ends every document title. */
export const APP_NAME = "Teacher Studio";

/**
 * A screen's title. It takes focus when the screen opens, so keyboard and screen-reader users land
 * at the top of the new screen instead of on the link they just followed, and names the screen in
 * the document title ("Gradebook · English 9 · Teacher Studio").
 */
export const PageHeading = ({ children, title }: {
  children: string;
  /** The screen's name in the document title, where the heading alone does not tell it apart. */
  title?: string | undefined;
}) => <ShellPageHeading app={APP_NAME} {...(title === undefined ? {} : { title })}>{children}</ShellPageHeading>;
