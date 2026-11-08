import { useEffect } from "react";
import {
  currentBrowser,
  startProductAnalytics,
  type ProductAnalyticsBrowser,
  type ProductAnalyticsSource,
  type ProductAnalyticsSurface,
} from "./productAnalytics.ts";

/**
 * Loads the district's product analytics on this app's pages once it may (SCHO-350): asks the
 * source whether it is on and who is signed in, then starts it, or does nothing. Any failure to
 * learn either leaves it off. Once its script runs it stays for the life of the page, so leaving
 * only cancels a start still waiting on the source.
 *
 * Give it a stable `source` (created once, outside render), so it asks once per page.
 */
export const useProductAnalytics = (
  source: ProductAnalyticsSource,
  surface: ProductAnalyticsSurface,
  browser?: ProductAnalyticsBrowser,
): void => {
  useEffect(() => {
    let cancelled = false;
    void Promise.all([source.config(), source.role()]).then(
      ([config, role]) => {
        if (!cancelled) startProductAnalytics(config, role, surface, browser ?? currentBrowser());
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [source, surface, browser]);
};
