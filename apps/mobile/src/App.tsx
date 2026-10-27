import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { CalendarDays, ChevronLeft, GraduationCap, Home, Library, MessageCircle, Settings2, Sparkles } from 'lucide-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import type { Detail, District, Principal, Session, Tab } from './types';
import { DistrictClient } from './api/client';
import { consumeIncomingUrl, signIn } from './auth/auth';
import { clearSession, prepareWebView, restoreSession } from './auth/session';
import { getDistricts, removeDistrict, saveDistrict } from './district';
import { palette } from './theme';
import { Button, Loading, Page } from './ui/Primitives';
import { Onboarding } from './screens/Onboarding';
import { Today } from './screens/Today';
import { Classes, FamilyChild, FamilyClass, StudentClass, TeacherClass } from './screens/Classes';
import { AssignmentScreen, Announcements, StudentGrades, WriteResponse } from './screens/Assignments';
import { TeacherAssignment, TeacherReview } from './screens/TeacherReview';
import { CalendarScreen } from './screens/Calendar';
import { Inbox } from './screens/Inbox';
import { Account } from './screens/Account';
import { Workspace } from './screens/Workspace';

const ACTIVE_KEY = 'educateos.active-district.v1';
const TABS = [
  { id: 'today', title: 'Today', Icon: Home },
  { id: 'classes', title: 'Classes', Icon: Library },
  { id: 'calendar', title: 'Calendar', Icon: CalendarDays },
  { id: 'inbox', title: 'Inbox', Icon: MessageCircle },
  { id: 'workspace', title: 'AI', Icon: Sparkles },
  { id: 'account', title: 'Account', Icon: Settings2 },
] as const;

function BottomTabs({ selected, select, unread }: {
  selected: Tab; select: (tab: Tab) => void; unread: number;
}) {
  return <View accessibilityRole="tablist"
    style={{ backgroundColor: palette.white, borderTopWidth: 1, borderColor: palette.line,
      flexDirection: 'row', paddingTop: 11, paddingBottom: 5, paddingHorizontal: 5 }}>
    {TABS.map(({ id, title, Icon }) => <Pressable key={id} accessibilityRole="tab"
      accessibilityLabel={title} accessibilityState={{ selected: selected === id }}
      onPress={() => select(id)} style={{ flex: 1, alignItems: 'center', justifyContent: 'center',
        gap: 5, minHeight: 47 }}>
      <View style={{ position: 'relative' }}>
        <Icon size={21} strokeWidth={selected === id ? 2.7 : 1.8}
          color={selected === id ? palette.primary : palette.subtle}/>
        {id === 'inbox' && unread > 0 && <View style={{ position: 'absolute', right: -7, top: -3,
          backgroundColor: palette.red, borderRadius: 6, minWidth: 9, height: 9, borderWidth: 1.5,
          borderColor: palette.white }}/>}
      </View>
      <Text style={{ fontSize: 10, fontWeight: selected === id ? '800' : '600',
        color: selected === id ? palette.primary : palette.subtle }}>{title}</Text>
    </Pressable>)}
  </View>;
}

function Header({ school, detail, onBack, onAccount }: {
  school: string; detail: boolean; onBack: () => void; onAccount: () => void;
}) {
  return <View style={{ backgroundColor: palette.white, flexDirection: 'row', alignItems: 'center',
    minHeight: 61, paddingHorizontal: 19, gap: 11, borderBottomWidth: 1,
    borderColor: palette.line }}>
    {detail ? <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Go back"
      style={{ width: 39, height: 39, alignItems: 'center', justifyContent: 'center',
        backgroundColor: palette.background, borderRadius: 13 }}>
      <ChevronLeft color={palette.ink} size={23}/>
    </Pressable> :
      <View style={{ width: 39, height: 39, backgroundColor: palette.primary,
        borderRadius: 13, justifyContent: 'center', alignItems: 'center' }}>
        <GraduationCap color={palette.white} size={23}/>
      </View>}
    <View style={{ flex: 1, gap: 3 }}>
      <Text style={{ fontSize: 16, color: palette.ink, fontWeight: '800' }} numberOfLines={1}>
        EducateOS
      </Text>
      <Text style={{ fontSize: 11, color: palette.muted }} numberOfLines={1}>{school}</Text>
    </View>
    <Pressable onPress={onAccount} accessibilityRole="button" accessibilityLabel="Account and school settings"
      style={{ backgroundColor: palette.primarySoft, borderRadius: 16, width: 39, height: 39,
        alignItems: 'center', justifyContent: 'center' }}>
      <Settings2 color={palette.primary} size={20}/>
    </Pressable>
  </View>;
}

function DetailView({ detail, client, navigate, goBack }: {
  detail: Detail; client: DistrictClient; navigate: (d: Detail) => void; goBack: () => void;
}) {
  switch (detail.type) {
    case 'class': return <StudentClass client={client} offeringId={detail.id} navigate={navigate}/>;
    case 'teacher-class': return <TeacherClass client={client} offeringId={detail.id} navigate={navigate}/>;
    case 'assignment': return <AssignmentScreen client={client} assignmentId={detail.id}
      offeringId={detail.offeringId} navigate={navigate}/>;
    case 'write': return <WriteResponse client={client} assignmentId={detail.id}
      offeringId={detail.offeringId} onComplete={goBack}/>;
    case 'teacher-assignment': return <TeacherAssignment client={client} assignmentId={detail.id}
      offeringId={detail.offeringId} navigate={navigate}/>;
    case 'teacher-review': return <TeacherReview client={client}
      submissionId={detail.id} studentName={detail.studentName} artifacts={detail.artifacts}/>;
    case 'family-child': return <FamilyChild client={client} studentId={detail.id} navigate={navigate}/>;
    case 'family-class': return <FamilyClass client={client} studentId={detail.studentId}
      offeringId={detail.offeringId}/>;
    case 'grades': return <StudentGrades client={client} navigate={navigate}/>;
    case 'announcements': return <Announcements client={client}/>;
  }
}

function WorkspaceOnly({ message, onWorkspace, onRetry }: {
  message: string; onWorkspace: () => void; onRetry: () => void;
}) {
  return <Page>
    <View style={{ paddingTop: 55, alignItems: 'center', gap: 14 }}>
      <View style={{ backgroundColor: palette.primarySoft, padding: 22, borderRadius: 25 }}>
        <Sparkles size={38} color={palette.primary}/>
      </View>
      <Text style={{ fontSize: 23, color: palette.ink, fontWeight: '800', textAlign: 'center' }}>
        Your school workspace is ready
      </Text>
      <Text style={{ fontSize: 14, textAlign: 'center', lineHeight: 22, color: palette.muted }}>
        {message}
      </Text>
    </View>
    <View style={{ gap: 11, marginTop: 30 }}>
      <Button label="Open AI workspace" onPress={onWorkspace}/>
      <Button label="Check school access again" variant="outline" onPress={onRetry}/>
    </View>
  </Page>;
}

function InnerApp() {
  const [booting, setBooting] = useState(true);
  const [districts, setDistricts] = useState<District[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [principalError, setPrincipalError] = useState<string | null>(null);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [tab, setTab] = useState<Tab>('today');
  const [detailStack, setDetailStack] = useState<Detail[]>([]);
  const [workspaceOpened, setWorkspaceOpened] = useState(false);
  const [unread, setUnread] = useState(0);
  const client = useMemo(() => session ? new DistrictClient(session.district.portal, session.credential) : null, [session]);
  const detail = detailStack.at(-1) || null;
  const navigate = useCallback((next: Detail) => setDetailStack((prev) => [...prev, next].slice(-8)), []);
  const goBack = useCallback(() => setDetailStack((prev) => prev.slice(0, -1)), []);
  const selectTab = useCallback((selected: Tab) => { setTab(selected); setDetailStack([]); }, []);

  useEffect(() => {
    const subscription = Linking.addEventListener('url', (event) => consumeIncomingUrl(event.url));
    void Linking.getInitialURL().then((url) => { if (url) consumeIncomingUrl(url); });
    let alive = true;
    void (async () => {
      const all = await getDistricts();
      const selected = await AsyncStorage.getItem(ACTIVE_KEY).catch(() => null);
      const district = all.find((d) => d.id === selected);
      let restored: Session | null = null;
      if (district) {
        restored = await restoreSession(district);
        if (restored) {
          try { await prepareWebView(restored); }
          catch { restored = null; }
        }
      }
      if (alive) { setDistricts(all); setSession(restored); setBooting(false); }
    })();
    return () => { alive = false; subscription.remove(); };
  }, []);

  useEffect(() => {
    let alive = true;
    setPrincipal(null); setPrincipalError(null);
    if (!client) return () => { alive = false; };
    if (!client.available) {
      setPrincipalError('This installation uses a Workshop password session. Native class dashboards require a school-managed Cloudflare Access sign-in. Your full AI workspace still works.');
      return () => { alive = false; };
    }
    setCheckingAccess(true);
    client.me().then((me) => { if (alive) { setPrincipal(me); setPrincipalError(null); } })
      .catch((e: unknown) => {
        if (alive) setPrincipalError(e instanceof Error ? e.message : 'School access could not be verified.');
      }).finally(() => { if (alive) setCheckingAccess(false); });
    return () => { alive = false; };
  }, [client]);

  useEffect(() => {
    let active = true;
    if (!client?.available || !principal) return () => { active = false; };
    const update = () => { void client.notifications().then((n) => {
      if (active) setUnread(n.unread);
    }).catch(() => {}); };
    update();
    const interval = setInterval(update, 90_000);
    return () => { active = false; clearInterval(interval); };
  }, [client, principal]);

  useEffect(() => {
    if (tab === 'workspace') setWorkspaceOpened(true);
  }, [tab]);

  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (detailStack.length > 0) { goBack(); return true; }
      if (tab !== 'today') { selectTab('today'); return true; }
      return false;
    });
    return () => listener.remove();
  }, [detailStack, tab, goBack, selectTab]);

  const connect = async (district: District) => {
    if (working) return;
    setWorking(true); setError(null);
    try {
      let restored = await restoreSession(district);
      if (!restored) restored = await signIn(district);
      await prepareWebView(restored);
      await AsyncStorage.setItem(ACTIVE_KEY, district.id);
      setSession(restored); setChoosing(false); setTab('today'); setDetailStack([]);
      setWorkspaceOpened(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Sign-in could not be completed.'); }
    finally { setWorking(false); }
  };
  const add = async (district: District) => { setDistricts(await saveDistrict(district)); };
  const remove = async (district: District) => {
    if (session?.district.id === district.id) await signOut();
    await clearSession(district);
    setDistricts(await removeDistrict(district.id));
  };
  const signOut = async () => {
    if (!session) return;
    await clearSession(session.district);
    await AsyncStorage.removeItem(ACTIVE_KEY);
    setPrincipal(null); setPrincipalError(null); setSession(null); setChoosing(false); setDetailStack([]);
    setTab('today'); setWorkspaceOpened(false);
  };
  const retryAccess = () => {
    if (!client) return;
    setCheckingAccess(true); setPrincipalError(null);
    void client.me().then((me) => setPrincipal(me))
      .catch((e: unknown) => setPrincipalError(e instanceof Error ? e.message : 'School access unavailable.'))
      .finally(() => setCheckingAccess(false));
  };

  if (booting) return <View style={{ flex: 1, backgroundColor: palette.background, justifyContent: 'center' }}>
    <Loading label="Preparing EducateOS…"/></View>;
  if (!session || choosing) return <View style={{ flex: 1, backgroundColor: palette.background }}>
    <Onboarding districts={districts} busy={working} error={error} onAdd={add} onConnect={connect}
      onRemove={(district) => { void remove(district); }}/>
    {session && <View style={{ paddingHorizontal: 20, paddingVertical: 10 }}>
      <Button label="Back to current school" onPress={() => setChoosing(false)} variant="outline"/>
    </View>}
  </View>;

  const authenticated = !!principal && !!client?.available;
  const fallback = principalError || 'The school could not confirm your class permissions.';
  const workspaceVisible = tab === 'workspace' && detail === null;

  return <View style={{ flex: 1, backgroundColor: palette.background }}>
    <Header school={session.district.name} detail={!!detail} onBack={goBack} onAccount={() => selectTab('account')}/>
    <View style={{ flex: 1, display: workspaceVisible ? 'flex' : 'none' }}>
      {workspaceOpened && <Workspace session={session} onReturn={() => setChoosing(true)}/>}
    </View>
    <View style={{ flex: 1, display: workspaceVisible ? 'none' : 'flex' }}>
      {detail && authenticated && client
        ? <DetailView detail={detail} client={client} navigate={navigate} goBack={goBack}/>
        : tab === 'account' ? <Account session={session} me={principal}
          onSwitch={() => setChoosing(true)} onSignOut={signOut}/>
        : tab === 'workspace' ? null
        : checkingAccess ? <Loading label="Checking district access…"/>
        : !authenticated || !client ? <WorkspaceOnly message={fallback}
          onWorkspace={() => selectTab('workspace')} onRetry={retryAccess}/>
        : tab === 'today' ? <Today client={client} me={principal} navigate={navigate} changeTab={selectTab}/>
        : tab === 'classes' ? <Classes client={client} me={principal} navigate={navigate}/>
        : tab === 'calendar' ? <CalendarScreen client={client} navigate={navigate}/>
        : tab === 'inbox' ? <Inbox client={client} navigate={navigate}/>
        : null}
    </View>
    <BottomTabs selected={tab} select={selectTab} unread={unread}/>
  </View>;
}

export default function App() {
  return <SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: palette.white }}
    edges={['top', 'bottom']}>
    <StatusBar barStyle="dark-content"/>
    <InnerApp/>
  </SafeAreaView></SafeAreaProvider>;
}
