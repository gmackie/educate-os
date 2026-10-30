/**
 * Android App Links for mobile.educateos.io (SCHO-262): the Digital Asset Links statement Android
 * fetches from `/.well-known/assetlinks.json` to verify the app's `autoVerify` intent filter
 * (apps/mobile/app.config.ts). iOS reads the static apple-app-site-association file instead.
 */
export type AndroidApp = { package: string; sha256: readonly string[] };

/**
 * Each build variant's Android package (apps/mobile/app.config.ts VARIANTS, SCHO-265) and the
 * SHA-256 fingerprints of the certificates that sign it, as `AA:BB:…` (32 bytes). Each variant has
 * its own EAS keystore; read a fingerprint from `eas credentials -p android` for that profile.
 *
 * - io.educateos.mobile: EAS keystore "Build Credentials 9NfQq4LN-f" (JKS, alias
 *   c854ddbcdeebdd37f481477d3f980af5), the Play upload key. Confirmed against a locally built APK
 *   with `apksigner verify --print-certs` (SCHO-262). When the app is enrolled in Play App Signing,
 *   Google re-signs store installs with its own key: add the "App signing key certificate" SHA-256
 *   from Play Console > Test and release > App integrity here as well, or store installs fail
 *   verification.
 * - com.gmacko.educateos.preview: "Build Credentials Lw22fhNjgg" (alias 4700e162a403553cca87fac5a222a39c).
 * - com.gmacko.educateos.dev: "Build Credentials Qg2bi_YIit" (alias 445dceb2b7b1c253083e143cf1adafe6).
 */
export const ANDROID_APPS: readonly AndroidApp[] = [
  { package: 'io.educateos.mobile', sha256: ['92:39:20:54:A7:89:BA:A5:79:6D:59:8B:DB:45:2D:93:95:D1:CE:C1:87:92:F7:BD:A5:F0:AB:4A:40:27:DF:7D'] },
  { package: 'com.gmacko.educateos.preview', sha256: ['39:C2:D2:5D:91:D5:38:5A:43:C0:4A:54:B0:0C:73:04:20:F5:B5:20:0A:D9:D4:46:8A:76:BB:DA:B4:35:E1:C4'] },
  { package: 'com.gmacko.educateos.dev', sha256: ['10:EB:67:BA:5F:BA:E3:3B:92:30:4D:6A:59:D5:7D:64:35:0C:B8:5E:B0:74:59:B7:E2:DD:7B:87:B9:68:F8:8C'] },
];

const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** One statement per package: the app may handle every URL on this host it claims. */
export type AssetLinkStatement = {
  relation: string[];
  target: { namespace: 'android_app'; package_name: string; sha256_cert_fingerprints: string[] };
};

/** The assetlinks.json body. Throws on a malformed fingerprint rather than publishing it. */
export function assetLinks(apps: readonly AndroidApp[] = ANDROID_APPS): AssetLinkStatement[] {
  return apps.map((app) => {
    for (const fingerprint of app.sha256) {
      if (!FINGERPRINT.test(fingerprint)) throw new Error('Android certificate fingerprints are 32 colon-separated upper-case hex bytes.');
    }
    return {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: app.package, sha256_cert_fingerprints: [...app.sha256] },
    };
  });
}
