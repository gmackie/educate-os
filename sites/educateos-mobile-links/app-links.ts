/**
 * Android App Links for mobile.educateos.io (SCHO-262): the Digital Asset Links statement Android
 * fetches from `/.well-known/assetlinks.json` to verify the app's `autoVerify` intent filter
 * (apps/mobile/app.config.ts). iOS reads the static apple-app-site-association file instead.
 */
export const ANDROID_PACKAGE = 'io.educateos.mobile';

/**
 * SHA-256 fingerprints of the certificates that sign the Android app, as `AA:BB:…` (32 bytes).
 *
 * - EAS keystore "Build Credentials 9NfQq4LN-f" (JKS, alias c854ddbcdeebdd37f481477d3f980af5),
 *   which signs the preview APKs and will be the Play upload key. Read from
 *   `eas credentials -p android` and confirmed against a locally built preview APK with
 *   `apksigner verify --print-certs` (SCHO-262).
 *
 * When the app is enrolled in Play App Signing, Google re-signs store installs with its own key:
 * add the "App signing key certificate" SHA-256 from Play Console > Test and release > App
 * integrity here as well, or store installs fail verification.
 */
export const ANDROID_CERT_SHA256: readonly string[] = [
  '92:39:20:54:A7:89:BA:A5:79:6D:59:8B:DB:45:2D:93:95:D1:CE:C1:87:92:F7:BD:A5:F0:AB:4A:40:27:DF:7D',
];

const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** One statement per package: the app may handle every URL on this host it claims. */
export type AssetLinkStatement = {
  relation: string[];
  target: { namespace: 'android_app'; package_name: string; sha256_cert_fingerprints: string[] };
};

/** The assetlinks.json body. Throws on a malformed fingerprint rather than publishing it. */
export function assetLinks(fingerprints: readonly string[] = ANDROID_CERT_SHA256): AssetLinkStatement[] {
  for (const fingerprint of fingerprints) {
    if (!FINGERPRINT.test(fingerprint)) throw new Error('Android certificate fingerprints are 32 colon-separated upper-case hex bytes.');
  }
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: [...fingerprints] },
  }];
}
