import { defineGadgetsWorker, bindings, type WranglerExtras } from '../../scripts/worker-config.ts';

export default {
  accountId: 'c07a7e704db1808e1fff91bed2b1cd49',
  ...defineGadgetsWorker({
  name: 'educateos-mobile-links',
  workersDev: false,
  previewUrls: false,
  entrypoint: 'worker.ts',
  domains: ['mobile.educateos.io'],
  assets: { notFoundHandling: '404-page', runWorkerFirst: ['/healthz', '/oauthredirect', '/authpopup', '/pairings', '/pairings/*'] },
  env: { ASSETS: bindings.assets(), PAIRINGS: bindings.durableObject({ worker: 'educateos-mobile-links', exportName: 'PhonePairing' }) },
  observability: { enabled: false },
  }),
};

export const wrangler = { assetsDirectory: '../../apps/mobile/app-links' } satisfies WranglerExtras;

export const migrations = [{ tag: 'v1', new_sqlite_classes: ['PhonePairing'] }];
