// Push notifications. Nothing is requested until the person opts in, and the district's alerts are
// content-free ("You have 2 updates"): the phone fetches the details itself after it is opened.
import { useEffect } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import type { DistrictClient } from './api/client';

const KEY = 'educateos.push.v1';

export type PushResult = 'enabled' | 'denied' | 'unsupported' | 'school-unsupported';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: true,
  }),
});

export async function pushOptedIn(): Promise<boolean> {
  return (await AsyncStorage.getItem(KEY).catch(() => null)) === 'on';
}

export async function setPushOptOut(): Promise<void> {
  await AsyncStorage.setItem(KEY, 'off').catch(() => {});
}

/** Asks for permission and registers the Expo push token with the school. Only after an explicit opt-in. */
export async function enablePush(client: DistrictClient | null): Promise<PushResult> {
  if (!Device.isDevice) return 'unsupported';
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'School updates', importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  const current = await Notifications.getPermissionsAsync();
  const permission = current.granted ? current : await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: false },
  });
  if (!permission.granted) return 'denied';
  await AsyncStorage.setItem(KEY, 'on').catch(() => {});
  // Only device credentials can register (it is /api/m/me/devices/push-token).
  if (!client?.usesDevice || !client.available) return 'school-unsupported';
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  try {
    const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
    const result = await client.registerPushToken(token, Platform.OS);
    return result === 'registered' ? 'enabled' : 'school-unsupported';
  } catch {
    return 'school-unsupported';
  }
}

/** Opening a notification goes to the inbox; the alert itself never carries school data. */
export function usePushResponses(): void {
  const router = useRouter();
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(() => router.navigate('/inbox'));
    return () => subscription.remove();
  }, [router]);
}
