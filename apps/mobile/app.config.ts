import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'EducateOS',
  slug: 'educateos-mobile',
  owner: 'gmacko',
  version: '0.1.0',
  scheme: 'educateos',
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  backgroundColor: '#F6F8FC',
  ios: {
    bundleIdentifier: 'io.educateos.mobile',
    supportsTablet: true,
    associatedDomains: ['applinks:mobile.educateos.io'],
    infoPlist: {
      NSFaceIDUsageDescription: 'Confirm access to your EducateOS school account.',
      NSCameraUsageDescription: 'Attach photos of your own schoolwork when you choose to.',
      NSPhotoLibraryUsageDescription: 'Choose photos to attach to your work.',
    },
  },
  android: {
    package: 'io.educateos.mobile',
    intentFilters: [{
      action: 'VIEW',
      data: [{ scheme: 'https', host: 'mobile.educateos.io', pathPrefix: '/oauthredirect' },
        { scheme: 'https', host: 'mobile.educateos.io', pathPrefix: '/authpopup' }],
      category: ['BROWSABLE', 'DEFAULT'],
      autoVerify: true,
    }],
    permissions: [],
  },
  plugins: [['expo-secure-store', { configureAndroidBackup: true }]],
  experiments: { tsconfigPaths: true },
  extra: {
    mobileCallbackOrigin: 'https://mobile.educateos.io',
    eas: { projectId: '4bb5e5bd-0dbb-453e-843b-1c96c4307851' },
  },
};
export default config;
