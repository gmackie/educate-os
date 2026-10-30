import AsyncStorage from '@react-native-async-storage/async-storage';
import type { District } from './types';
import { MAX_SCHOOLS, normalizeDistricts } from './schools';
export { strictOrigin, trustedUrl, CALLBACK_ORIGIN } from './security';

const KEY = 'educateos.installations.v2';
/** Written by builds before the one-origin redesign; migrated on read (schools.ts). */
const LEGACY_KEY = 'educateos.installations.v1';

async function read(key: string): Promise<unknown> {
  try { return JSON.parse((await AsyncStorage.getItem(key)) || 'null') as unknown; } catch { return null; }
}

export async function getDistricts(): Promise<District[]> {
  const current = await read(KEY);
  if (Array.isArray(current)) return normalizeDistricts(current);
  const legacy = normalizeDistricts(await read(LEGACY_KEY));
  if (legacy.length > 0) await AsyncStorage.setItem(KEY, JSON.stringify(legacy)).catch(() => {});
  return legacy;
}
export async function saveDistrict(district: District): Promise<District[]> {
  const list = await getDistricts();
  const next = [district, ...list.filter((d) => d.id !== district.id && d.origin !== district.origin)].slice(0, MAX_SCHOOLS);
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
export async function removeDistrict(id: string): Promise<District[]> {
  const next = (await getDistricts()).filter((d) => d.id !== id);
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
