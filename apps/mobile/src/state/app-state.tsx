import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Credential, District, Principal, Role, Session } from '../types';
import { DistrictClient } from '../api/client';
import { DistrictApiError } from '../api/errors';
import type { DeviceSession } from '../api/device';
import { deviceSession, secureVault } from '../api/deviceVault';
import { signIn } from '../auth/auth';
import { clearSession, prepareWebView, restoreSession } from '../auth/session';
import { getDistricts, removeDistrict, saveDistrict } from '../district';
import { fetchSchoolManifest } from '../manifest';
import { districtFromManifest } from '../schools';

const ACTIVE_KEY = 'educateos.active-district.v1';

export function roleOf(principal: Principal | null): Role {
  if (principal?.kind === 'guardian') return 'guardian';
  if (principal?.kind === 'staff') return 'teacher';
  return 'student';
}

type AppState = {
  booting: boolean;
  districts: District[];
  session: Session | null;
  client: DistrictClient | null;
  principal: Principal | null;
  principalError: string | null;
  checkingAccess: boolean;
  unread: number;
  role: Role;
  /** The school that signed this phone out, until the person moves on. */
  revoked: District | null;
  /** Makes a freshly connected school the active one. */
  activate: (district: District, credential: Credential) => Promise<void>;
  /** Opens a saved school: its stored credential, or the legacy sign-in. False when it must pair again. */
  openSchool: (district: District) => Promise<boolean>;
  removeSchool: (district: District) => Promise<void>;
  signOut: () => Promise<void>;
  retryAccess: () => void;
  dismissRevoked: () => void;
  refreshUnread: () => void;
};

const Context = createContext<AppState | null>(null);

export function useAppState(): AppState {
  const value = useContext(Context);
  if (!value) throw new Error('useAppState outside AppStateProvider');
  return value;
}

async function restore(district: District, onRevoked: () => void): Promise<{ session: Session; device?: DeviceSession } | null> {
  const stored = await secureVault(district.origin).load();
  if (stored && stored.refreshTokenExpiresAt > Date.now()) {
    return {
      session: { district, credential: { kind: 'device', deviceId: stored.deviceId, principalId: stored.principalId }, confirmedAt: Date.now() },
      device: deviceSession(district.origin, onRevoked),
    };
  }
  const legacy = await restoreSession(district);
  if (!legacy) return null;
  try { await prepareWebView(legacy); } catch { return null; }
  return { session: legacy };
}

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [booting, setBooting] = useState(true);
  const [districts, setDistricts] = useState<District[]>([]);
  const [current, setCurrent] = useState<{ session: Session; device?: DeviceSession } | null>(null);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [principalError, setPrincipalError] = useState<string | null>(null);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [unread, setUnread] = useState(0);
  const [revoked, setRevoked] = useState<District | null>(null);
  const [accessTick, setAccessTick] = useState(0);
  const [unreadTick, setUnreadTick] = useState(0);
  const currentRef = useRef(current);
  currentRef.current = current;

  const onRevokedFor = useCallback((district: District) => () => {
    void AsyncStorage.removeItem(ACTIVE_KEY);
    setRevoked(district);
    setCurrent(null);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const all = await getDistricts();
      const selected = await AsyncStorage.getItem(ACTIVE_KEY).catch(() => null);
      const district = all.find((d) => d.id === selected);
      const restored = district ? await restore(district, onRevokedFor(district)).catch(() => null) : null;
      if (!alive) return;
      setDistricts(all); setCurrent(restored); setBooting(false);
      // Keep the school's name, brand and features current; failures keep what we have.
      if (district && !district.legacy) {
        void fetchSchoolManifest(district.origin).then(async (manifest) => {
          const fresh = { ...districtFromManifest(manifest), id: district.id };
          const list = await saveDistrict(fresh);
          if (!alive) return;
          setDistricts(list);
          setCurrent((c) => c && c.session.district.id === fresh.id ? { ...c, session: { ...c.session, district: fresh } } : c);
        }).catch(() => {});
      }
    })();
    return () => { alive = false; };
  }, [onRevokedFor]);

  const session = current?.session ?? null;
  const client = useMemo(() => current
    ? new DistrictClient(current.session.district.origin, current.session.credential, current.device)
    : null, [current]);

  useEffect(() => {
    let alive = true;
    setPrincipal(null); setPrincipalError(null);
    if (!client) return () => { alive = false; };
    if (!client.available) {
      setPrincipalError('This installation uses a Workshop password session. Native class dashboards need your school to connect this phone. Your full AI workspace still works.');
      return () => { alive = false; };
    }
    setCheckingAccess(true);
    client.me().then((me) => { if (alive) { setPrincipal(me); setPrincipalError(null); } })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof DistrictApiError && e.code === 'needs-pairing') {
          setCurrent(null);
          return;
        }
        setPrincipalError(e instanceof Error ? e.message : 'School access could not be verified.');
      }).finally(() => { if (alive) setCheckingAccess(false); });
    return () => { alive = false; };
  }, [client, accessTick]);

  useEffect(() => {
    let active = true;
    if (!client?.available || !principal) return () => { active = false; };
    const update = () => {
      void client.notifications().then((n) => { if (active) setUnread(n.unread); }).catch(() => {});
    };
    update();
    const interval = setInterval(update, 90_000);
    return () => { active = false; clearInterval(interval); };
  }, [client, principal, unreadTick]);

  const activate = useCallback(async (district: District, credential: Credential) => {
    setDistricts(await saveDistrict(district));
    await AsyncStorage.setItem(ACTIVE_KEY, district.id);
    setRevoked(null);
    setCurrent({
      session: { district, credential, confirmedAt: Date.now() },
      device: credential.kind === 'device' ? deviceSession(district.origin, onRevokedFor(district)) : undefined,
    });
  }, [onRevokedFor]);

  const openSchool = useCallback(async (district: District) => {
    let restored = await restore(district, onRevokedFor(district));
    if (!restored && district.legacy) {
      const signedIn = await signIn(district);
      await prepareWebView(signedIn);
      restored = { session: signedIn };
    }
    if (!restored) return false;
    setDistricts(await saveDistrict(district));
    await AsyncStorage.setItem(ACTIVE_KEY, district.id);
    setRevoked(null);
    setCurrent(restored);
    return true;
  }, [onRevokedFor]);

  const signOut = useCallback(async () => {
    const active = currentRef.current;
    if (!active) return;
    if (active.device && active.session.credential.kind === 'device') {
      // Tell the school first, so "Your devices" shows this phone as signed out; then forget it.
      const deviceId = active.session.credential.deviceId;
      await new DistrictClient(active.session.district.origin, active.session.credential, active.device)
        .revokeDevice(deviceId).catch(() => {});
      await active.device.forget();
    }
    await clearSession(active.session.district).catch(() => {});
    await AsyncStorage.removeItem(ACTIVE_KEY);
    setPrincipal(null); setPrincipalError(null); setUnread(0); setCurrent(null);
  }, []);

  const removeSchool = useCallback(async (district: District) => {
    if (currentRef.current?.session.district.id === district.id) await signOut();
    await secureVault(district.origin).clear();
    await clearSession(district).catch(() => {});
    setDistricts(await removeDistrict(district.id));
  }, [signOut]);

  const value = useMemo<AppState>(() => ({
    booting, districts, session, client, principal, principalError, checkingAccess, unread,
    role: roleOf(principal), revoked, activate, openSchool, removeSchool, signOut,
    retryAccess: () => setAccessTick((n) => n + 1),
    dismissRevoked: () => setRevoked(null),
    refreshUnread: () => setUnreadTick((n) => n + 1),
  }), [booting, districts, session, client, principal, principalError, checkingAccess, unread, revoked,
    activate, openSchool, removeSchool, signOut]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}
