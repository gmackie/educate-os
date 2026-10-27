import AsyncStorage from '@react-native-async-storage/async-storage';
import type { District } from './types';
import { strictOrigin } from './security';
export { strictOrigin, trustedUrl } from './security';

const KEY = 'educateos.installations.v1';
export const CALLBACK_ORIGIN = 'https://mobile.educateos.io';
export function makeDistrict(name: string, portal: string, workshop: string, allowLocal = false): District {
  const school = strictOrigin(portal, allowLocal);
  const workspace = strictOrigin(workshop, allowLocal);
  const label = name.trim().slice(0, 90);
  if (label.length < 2) throw new Error('Name your school or district.');
  return { id: workspace + '|' + school, name: label, portal: school, workshop: workspace };
}

export async function getDistricts(): Promise<District[]> {
  try {
    const value = JSON.parse((await AsyncStorage.getItem(KEY)) || '[]') as unknown;
    return Array.isArray(value) ? value.filter((x): x is District => {
      if (!x || typeof x !== 'object') return false;
      const d = x as Partial<District>;
      try {
        return typeof d.name === 'string' && typeof d.id === 'string' &&
          typeof d.portal === 'string' && typeof d.workshop === 'string' &&
          d.portal === strictOrigin(d.portal) && d.workshop === strictOrigin(d.workshop) &&
          d.id === d.workshop + '|' + d.portal;
      } catch { return false; }
    }).slice(0, 30) : [];
  } catch { return []; }
}
export async function saveDistrict(district: District): Promise<District[]> {
  const list = await getDistricts();
  const next = [district, ...list.filter((d) => d.id !== district.id)].slice(0, 30);
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
export async function removeDistrict(id: string): Promise<District[]> {
  const next = (await getDistricts()).filter((d) => d.id !== id);
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
