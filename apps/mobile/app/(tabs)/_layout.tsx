import { useState } from 'react';
import { Image, Text, View } from 'react-native';
import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CalendarDays, ClipboardCheck, GraduationCap, Home, Library, MessageCircle, Sparkles, UserRound, Users,
} from 'lucide-react-native';
import type { Tab } from '../../src/types';
import { useAppState } from '../../src/state/app-state';
import { tabsFor } from '../../src/tabs';
import { usePalette } from '../../src/ui/theme-context';
import { Loading } from '../../src/ui/Primitives';

const TAB_DETAILS: Record<Tab, { title: string; Icon: typeof Home }> = {
  family: { title: 'Family', Icon: Users },
  today: { title: 'Today', Icon: Home },
  agenda: { title: 'Calendar', Icon: CalendarDays },
  classes: { title: 'Classes', Icon: Library },
  review: { title: 'Review', Icon: ClipboardCheck },
  ai: { title: 'AI', Icon: Sparkles },
  inbox: { title: 'Inbox', Icon: MessageCircle },
  me: { title: 'Me', Icon: UserRound },
};
/** Declaration order; each role's visible subset keeps this order (src/tabs.ts). */
const ORDER: Tab[] = ['family', 'today', 'agenda', 'classes', 'review', 'ai', 'inbox', 'me'];

function SchoolHeader({ name, logo }: { name: string; logo: string | null | undefined }) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const [logoFailed, setLogoFailed] = useState(false);
  return <View style={{ backgroundColor: palette.surface, paddingTop: insets.top, borderBottomWidth: 1, borderColor: palette.line }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: 19, gap: 11 }}>
      {logo && !logoFailed
        ? <Image source={{ uri: logo }} onError={() => setLogoFailed(true)} accessibilityIgnoresInvertColors
          style={{ width: 36, height: 36, borderRadius: 11 }} resizeMode="contain"/>
        : <View style={{ width: 36, height: 36, backgroundColor: palette.primary, borderRadius: 11,
          justifyContent: 'center', alignItems: 'center' }}>
          <GraduationCap color={palette.onPrimary} size={21}/>
        </View>}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 16, color: palette.ink, fontWeight: '800' }} numberOfLines={1}>{name}</Text>
        <Text style={{ fontSize: 11, color: palette.muted }} numberOfLines={1}>EducateOS</Text>
      </View>
    </View>
  </View>;
}

export default function TabsLayout() {
  const { booting, session, revoked, role, unread } = useAppState();
  const palette = usePalette();
  if (booting) return <View style={{ flex: 1, backgroundColor: palette.background, justifyContent: 'center' }}><Loading/></View>;
  if (revoked) return <Redirect href="/signed-out"/>;
  if (!session) return <Redirect href="/welcome"/>;
  const visible = new Set(tabsFor(role, session.district.features));
  return <View style={{ flex: 1, backgroundColor: palette.background }}>
    <SchoolHeader name={session.district.name} logo={session.district.brand?.logo}/>
    <Tabs screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: palette.primary, tabBarInactiveTintColor: palette.subtle,
      tabBarStyle: { backgroundColor: palette.surface, borderTopColor: palette.line },
      sceneStyle: { backgroundColor: palette.background },
    }}>
      {ORDER.map((tab) => {
        const { title, Icon } = TAB_DETAILS[tab];
        return <Tabs.Screen key={tab} name={tab} options={{
          title,
          // Hidden tabs stay routable (a notification can open the inbox) but have no button.
          href: visible.has(tab) ? undefined : null,
          tabBarAccessibilityLabel: title,
          tabBarBadge: tab === 'inbox' && unread > 0 ? (unread > 99 ? '99+' : unread) : undefined,
          tabBarIcon: ({ color, focused }) => <Icon size={21} color={color} strokeWidth={focused ? 2.6 : 1.8}/>,
        }}/>;
      })}
    </Tabs>
  </View>;
}
