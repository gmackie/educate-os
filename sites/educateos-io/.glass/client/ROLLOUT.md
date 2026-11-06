# observe.gmac.io rollout

Browser integration is present but disabled. The analytics endpoint returned HTTP 522 during preparation. Enable only after DATFLR-1 proves its production deployment and the project is registered. This uses the direct HTTPS endpoint; no Worker service name/account is assumed. Worker/DO capture is available through worker.ts with an optional DATAFLARE service binding. Await capture or persist an application outbox; do not treat waitUntil as durable delivery.

The conservative bootstrap only records pageview screen categories, strips URL parameters/entity IDs/title/referrer, disables flags/replay/click/error capture and honors DNT/GPC. It is enabled only with data-enabled="true". Product apps store an anonymous browser ID for session journeys. Marketing uses cookieless capture. Custom domain events need explicit catalog and code instrumentation in a later slice.

Students, the demo, operator console, intake and district routes are excluded from educateOS marketing capture. This does not implement district authorization or FERPA/COPPA compliance. Flightdeck remains in place until replacement acceptance passes.
