import type { ReactNode } from "react";
import { Link } from "@cloudflare/kumo";

/** Whether `href` is an absolute `https` URL, the only kind the Learning Home links out to. */
export const isSafeExternalUrl = (href: string): boolean => {
  try {
    return new URL(href).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * A link out of the Learning Home. It opens in a new tab with no opener and no referrer, so the
 * page it opens can neither script this one nor learn which class or activity linked to it, and it
 * renders as plain text for anything but `https`, which rules out `javascript:` and `data:` links.
 */
export const SafeExternalLink = ({ href, children }: { href: string; children: ReactNode }) =>
  isSafeExternalUrl(href) ? (
    <Link href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <Link.ExternalIcon />
      <span className="sr-only"> (opens in a new tab)</span>
    </Link>
  ) : (
    <span>{children}</span>
  );
