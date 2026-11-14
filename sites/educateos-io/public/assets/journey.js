// @ts-check
// The educateos.io marketing funnel on observe (SCHO-400, DATFLR-9).
//
// stamp.mjs loads this beside /assets/dataflare.js, and only on the reviewed marketing paths, so it
// never runs on the demo, intake, district or student surfaces. The loader there is cookieless with
// identify off: this site has no accounts, and a visit is never linked to a person, so this file has
// no identify or reset either.
//
// The funnel: $pageview -> cta_clicked -> overview_downloaded / pilot_kit_printed -> contact_requested.
// cta_clicked and contact_requested are declarative (data-glass-event on the link); this file adds
// the two that a link attribute cannot express. Props are small enums only, never page text or URLs.
(() => {
  /**
   * @typedef {'cta_clicked' | 'contact_requested' | 'overview_downloaded' | 'pilot_kit_printed'} JourneyEvent
   * @typedef {Record<string, string | number | boolean>} JourneyProps
   * @typedef {{track(event: JourneyEvent, props?: JourneyProps): void}} Dataflare
   */

  const OVERVIEW_PDF = '/educateos-district-overview.pdf';
  // The one-page leave-behinds (SCHO-405): /pilot/brief/<audience>/ and the PDF beside each.
  const BRIEF = /^\/pilot\/brief\/(superintendents|principals|teachers|it)\/(?:educateos-brief-\1\.pdf)?$/;

  /** The page's first path segment as a small enum: "/" is "home", "/it/install/" is "it". */
  function pageKey() {
    const segment = location.pathname.split('/')[1] || 'home';
    return /^[a-z][a-z0-9-]{0,31}$/.test(segment) ? segment : 'other';
  }

  /**
   * Records one funnel event. A no-op without the loader (collection off, or a page it skips), and
   * analytics never breaks the page.
   * @param {JourneyEvent} event
   * @param {JourneyProps} [props]
   */
  function track(event, props) {
    try {
      /** @type {Dataflare | undefined} */ (/** @type {any} */ (window).dataflare)?.track(event, props);
    } catch {
      // Analytics is best effort.
    }
  }

  document.addEventListener(
    'click',
    (click) => {
      const link = click.target instanceof Element ? click.target.closest('a[href]') : null;
      if (!link) return;
      let path = '';
      try {
        path = new URL(link.getAttribute('href') || '', location.href).pathname;
      } catch {
        return;
      }
      if (path === OVERVIEW_PDF) track('overview_downloaded', {page: pageKey()});
      const brief = BRIEF.exec(path);
      if (brief && path.endsWith('.pdf')) track('overview_downloaded', {page: pageKey(), brief: brief[1]});
    },
    {capture: true},
  );

  // The founding pilot page offers "Print or save as PDF"; a district printing it, or one of the
  // leave-behinds under it, is a strong signal.
  window.addEventListener('beforeprint', () => {
    const brief = BRIEF.exec(location.pathname);
    if (brief) track('pilot_kit_printed', {page: 'pilot', brief: brief[1]});
    else if (pageKey() === 'pilot') track('pilot_kit_printed', {page: 'pilot'});
  });

  /** @type {any} */ (window).educateosJourney = {track, pageKey};
})();
