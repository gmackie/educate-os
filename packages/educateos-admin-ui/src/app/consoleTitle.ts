import { documentTitle, useScreenTitle } from "@educateos/shell";

/** The console's name, which ends every document title (WCAG 2.4.2, SCHO-382). */
export const APP_NAME = "EducateOS district admin";

/**
 * Names what the console shows in the document title, over its route's name: "Lincoln High ·
 * EducateOS district admin". Undefined leaves the route's title.
 */
export const useConsoleTitle = (name: string | undefined): void =>
  useScreenTitle(name === undefined ? undefined : documentTitle(name, APP_NAME));
