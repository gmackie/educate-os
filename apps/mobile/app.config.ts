import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'EducateOS',
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
  ios: {
    bundleIdentifier: 'io.educateos.mobile',
    supportsTablet: true,
    associatedDomains: ['applinks:mobile.educateos.io', 'webcredentials:mobile.educateos.io'],
    infoPlist: {
      NSFaceIDUsageDescription: 'Confirm access to your EducateOS school account.',
      NSCameraUsageDescription: "Scan your school's QR code to connect this phone, and attach photos of your own schoolwork when you choose to.",
      NSPhotoLibraryUsageDescription: 'Choose photos to attach to your work.',
    },
  },
  android: {
    package: 'io.educateos.mobile',
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
    'expo-notifications',
  ],
  experiments: { tsconfigPaths: true },
  extra: {
    mobileCallbackOrigin: 'https://mobile.educateos.io',
    // "Find my school" (src/directory.ts): off until the educateos.io directory is live.
    schoolDirectory: { enabled: false, url: 'https://educateos.io/api/schools/search' },
    eas: { projectId: '4bb5e5bd-0dbb-453e-843b-1c96c4307851' },
  },
};
export default config;
