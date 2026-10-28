// The app's side of device.ts: SecureStore storage, randomness and this phone's description.
import * as SecureStore from 'expo-secure-store';
import * as ExpoCrypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { base64urlnopad } from '@scure/base';
import { DeviceSession, generateDeviceKey, type DeviceVault, type StoredDevice } from './device';
import type { PairCredential, PairDevice } from './pairing';

const PREFIX = 'educateos.device.';
const OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

async function keyFor(origin: string): Promise<string> {
  return PREFIX + await ExpoCrypto.digestStringAsync(ExpoCrypto.CryptoDigestAlgorithm.SHA256, origin);
}

function valid(value: unknown): value is StoredDevice {
  const d = value as Partial<StoredDevice> | null;
  return !!d && d.v === 1 && typeof d.deviceId === 'string' && typeof d.principalId === 'string' &&
    typeof d.privateKey === 'string' && typeof d.accessToken === 'string' && typeof d.refreshToken === 'string' &&
    typeof d.accessTokenExpiresAt === 'number' && typeof d.refreshTokenExpiresAt === 'number';
}

/** One district's device credential, in the keychain/keystore, this device only, while unlocked. */
export function secureVault(origin: string): DeviceVault {
  return {
    async load() {
      try {
        const raw = await SecureStore.getItemAsync(await keyFor(origin), OPTIONS);
        const value: unknown = raw ? JSON.parse(raw) : null;
        return valid(value) ? value : null;
      } catch { return null; }
    },
    async save(device) {
      await SecureStore.setItemAsync(await keyFor(origin), JSON.stringify(device), OPTIONS);
    },
    async clear() {
      await SecureStore.deleteItemAsync(await keyFor(origin), OPTIONS).catch(() => {});
    },
  };
}

export function newDeviceKey() {
  return generateDeviceKey((n) => ExpoCrypto.getRandomBytes(n));
}

export function deviceSession(origin: string, onRevoked?: () => void): DeviceSession {
  return new DeviceSession(origin, secureVault(origin), { randomId: () => ExpoCrypto.randomUUID(), onRevoked });
}

/** Stores a freshly paired credential with its key. */
export async function storePairedDevice(origin: string, privateKey: Uint8Array, credential: PairCredential): Promise<StoredDevice> {
  const now = Date.now();
  const time = (value: string | undefined, fallback: number) => {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const device: StoredDevice = {
    v: 1, deviceId: credential.deviceId, principalId: credential.principalId,
    privateKey: base64urlnopad.encode(privateKey),
    accessToken: credential.accessToken, accessTokenExpiresAt: time(credential.accessTokenExpiresAt, now + 14 * 60_000),
    refreshToken: credential.refreshToken, refreshTokenExpiresAt: time(credential.refreshTokenExpiresAt, now + 29 * 86_400_000),
  };
  await secureVault(origin).save(device);
  return device;
}

/** How this phone describes itself to the district (shown under "Your devices"). */
export function describeDevice(): PairDevice {
  const model = Device.modelName || (Platform.OS === 'ios' ? 'iPhone' : 'Android phone');
  return {
    label: Device.deviceName || model,
    platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'other',
    model,
    appVersion: Application.nativeApplicationVersion || Constants.expoConfig?.version || '0',
  };
}
