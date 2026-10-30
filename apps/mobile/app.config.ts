import type { ExpoConfig } from 'expo/config';

/**
 * Build variants (SCHO-265). eas.json sets APP_VARIANT per build profile; local `expo start` and
 * `expo run:*` default to development, so only an EAS production build carries the store identity.
 * Dev and preview builds have their own iOS bundle ID and Android package, so they install beside
 * the store app and are signed with their own credentials. mobile.educateos.io lists every
 * identifier in its apple-app-site-association and assetlinks.json (sites/educateos-mobile-links).
 */
export const VARIANTS = {
  development: { id: 'com.gmacko.educateos.dev', name: 'EducateOS Dev' },
  preview: { id: 'com.gmacko.educateos.preview', name: 'EducateOS Preview' },
  production: { id: 'io.educateos.mobile', name: 'EducateOS' },
} as const;
export type AppVariant = keyof typeof VARIANTS;

export function appVariant(value = process.env.APP_VARIANT): AppVariant {
  const variant = value || 'development';
  if (!Object.hasOwn(VARIANTS, variant)) throw new Error(`APP_VARIANT must be one of ${Object.keys(VARIANTS).join(', ')}.`);
  return variant as AppVariant;
}

export const appConfig = (variant: AppVariant): ExpoConfig => ({
  name: VARIANTS[variant].name,
  slug: 'educateos-mobile',
  owner: 'gmacko',
  version: '0.1.0',
  scheme: 'educateos',
  // Native only: expo-router would otherwise add a web target (and need react-native-web).
  platforms: ['ios', 'android'],
  orientation: 'default',
  // Light and dark palettes (src/theme.ts); the person can override the system under Me.
  userInterfaceStyle: 'automatic',
  backgroundColor: '#F6F8FC',
  // The EducateOS mark on its brand blue #0035D3 (SCHO-268). iOS masks the full-bleed square itself.
  icon: './assets/icon.png',
  ios: {
    bundleIdentifier: VARIANTS[variant].id,
    supportsTablet: true,
    associatedDomains: ['applinks:mobile.educateos.io', 'webcredentials:mobile.educateos.io'],
    infoPlist: {
      NSFaceIDUsageDescription: 'Confirm access to your EducateOS school account.',
      NSCameraUsageDescription: "Scan your school's QR code to connect this phone, and attach photos of your own schoolwork when you choose to.",
      NSPhotoLibraryUsageDescription: 'Choose photos to attach to your work.',
      // Only standard, exempt encryption (HTTPS, platform crypto), so uploads skip the export question.
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: VARIANTS[variant].id,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      monochromeImage: './assets/monochrome-icon.png',
      backgroundColor: '#0035D3',
    },
    intentFilters: [{
      action: 'VIEW',
      data: [{ scheme: 'https', host: 'mobile.educateos.io', pathPrefix: '/oauthredirect' },
        { scheme: 'https', host: 'mobile.educateos.io', pathPrefix: '/authpopup' },
        { scheme: 'https', host: 'mobile.educateos.io', pathPrefix: '/enroll' },
        { scheme: 'https', host: 'mobile.educateos.io', pathPrefix: '/pair-phone' },
        { scheme: 'https', host: 'mobile.educateos.io', path: '/j' }],
      category: ['BROWSABLE', 'DEFAULT'],
      autoVerify: true,
    }],
    permissions: [],
  },
  plugins: [
    'expo-router',
    ['expo-secure-store', { configureAndroidBackup: true }],
    ['expo-camera', {
      cameraPermission: "Scan your school's QR code to connect this phone, and attach photos of your own schoolwork when you choose to.",
      microphonePermission: false, recordAudioAndroid: false,
    }],
    ['expo-local-authentication', { faceIDPermission: 'Confirm access to your EducateOS school account.' }],
    ['expo-notifications', { icon: './assets/notification-icon.png', color: '#0035D3' }],
  ],
  experiments: { tsconfigPaths: true },
  extra: {
    mobileCallbackOrigin: 'https://mobile.educateos.io',
    // "Find my school" (src/directory.ts): off until the educateos.io directory is live.
    schoolDirectory: { enabled: false, url: 'https://educateos.io/api/schools/search' },
    eas: { projectId: '4bb5e5bd-0dbb-453e-843b-1c96c4307851' },
  },
});

export default appConfig(appVariant());
