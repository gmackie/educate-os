/**
 * Android App Links for mobile.educateos.io (SCHO-262): the Digital Asset Links statement Android
 * fetches from `/.well-known/assetlinks.json` to verify the app's `autoVerify` intent filter
 * (apps/mobile/app.config.ts). iOS reads the static apple-app-site-association file instead.
 */
export const ANDROID_PACKAGE = 'io.educateos.mobile';

/**
 * SHA-256 fingerprints of the certificates that sign the Android app, as `AA:BB:…` (32 bytes).
 *
 * TODO(SCHO-262): add the Play App Signing certificate and the EAS upload certificate
 * (`eas credentials -p android`, or Play Console > Test and release > App integrity). Until they
 * are listed, Android verification fails closed: links open this site's pages, whose
 * "Open EducateOS" button still reaches the app through its custom scheme.
 */
export const ANDROID_CERT_SHA256: readonly string[] = [];

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
