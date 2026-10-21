import { Text } from "@cloudflare/kumo";

// Module-level so React sees one ref callback and focuses only when a new heading mounts.
const focusOnMount = (heading: HTMLHeadingElement | null) => heading?.focus();

/**
 * A screen's title. It takes focus when the screen opens, so keyboard and screen-reader users
 * land at the top of the new screen instead of on the link they just followed.
 */
export const PageHeading = ({ children }: { children: string }) => (
  <h1 tabIndex={-1} ref={focusOnMount} className="rounded outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand">
    <Text variant="heading" size="lg" as="span">{children}</Text>
  </h1>
);
