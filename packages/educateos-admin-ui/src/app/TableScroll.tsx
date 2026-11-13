import type { ReactNode } from "react";

/**
 * The horizontal scroll container a wide table sits in, so a phone scrolls the table rather than
 * the page (WCAG 1.4.10). It takes focus, so a keyboard can scroll it even when the table holds
 * nothing focusable (WCAG 2.1.1), and it is a named group, so a screen reader says what it holds. A
 * group rather than a region: the section around a table is usually its landmark already.
 */
export const TableScroll = ({ label, children }: { label: string; children: ReactNode }) => (
  <div
    role="group"
    aria-label={label}
    tabIndex={0}
    className="overflow-x-auto rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
  >
    {children}
  </div>
);
