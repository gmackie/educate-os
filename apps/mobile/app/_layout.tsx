import '../src/polyfills';
import { useMemo } from 'react';
import { Stack } from 'expo-router/stack';
import { DarkTheme, DefaultTheme, ThemeProvider as NavigationTheme } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppStateProvider, useAppState } from '../src/state/app-state';
import { ThemeProvider, useTheme } from '../src/ui/theme-context';
import { AppLockGate } from '../src/lock';
import { usePushResponses } from '../src/push';

function Navigator() {
  const { mode, palette } = useTheme();
  usePushResponses();
  const theme = useMemo(() => {
    const base = mode === 'dark' ? DarkTheme : DefaultTheme;
    return { ...base, colors: { ...base.colors, primary: palette.primary, background: palette.background,
      card: palette.surface, text: palette.ink, border: palette.line, notification: palette.red } };
  }, [mode, palette]);
  return <NavigationTheme value={theme}>
    {/* The status bar follows the resolved theme, not the system, so a user override is honoured. */}
    <StatusBar style={mode === 'dark' ? 'light' : 'dark'}/>
    <AppLockGate>
      <Stack screenOptions={{
        headerTintColor: palette.primary, headerStyle: { backgroundColor: palette.surface },
        headerTitleStyle: { color: palette.ink }, contentStyle: { backgroundColor: palette.background },
        headerBackTitle: 'Back',
      }}>
        <Stack.Screen name="index" options={{ headerShown: false }}/>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }}/>
        <Stack.Screen name="welcome" options={{ headerShown: false }}/>
        <Stack.Screen name="scan" options={{ title: 'Scan school code' }}/>
        <Stack.Screen name="address" options={{ title: 'Web address' }}/>
        <Stack.Screen name="find" options={{ title: 'Find my school' }}/>
        {/* One instance each: a code opened while the screen is up replaces its school (src/links.ts). */}
        <Stack.Screen name="connect" dangerouslySingular options={{ title: 'Connect this phone' }}/>
        <Stack.Screen name="legacy-pair" dangerouslySingular options={{ title: 'Connect from your computer' }}/>
        <Stack.Screen name="permissions" options={{ headerShown: false, gestureEnabled: false }}/>
        <Stack.Screen name="signed-out" options={{ headerShown: false, gestureEnabled: false }}/>
        <Stack.Screen name="delete-account" options={{ title: 'Delete account' }}/>
        <Stack.Screen name="devices" options={{ title: 'Your devices' }}/>
        <Stack.Screen name="calendar" options={{ title: 'Calendar' }}/>
        <Stack.Screen name="class/[id]" options={{ title: 'Class' }}/>
        <Stack.Screen name="assignment/[id]/index" options={{ title: 'Assignment' }}/>
        <Stack.Screen name="assignment/[id]/write" options={{ title: 'Write a response' }}/>
        <Stack.Screen name="review/[id]" options={{ title: 'Review' }}/>
        <Stack.Screen name="family/[id]/index" options={{ title: 'Family' }}/>
        <Stack.Screen name="family/[id]/class/[offering]" options={{ title: 'Class' }}/>
        <Stack.Screen name="grades" options={{ title: 'Grades' }}/>
        <Stack.Screen name="announcements" options={{ title: 'Announcements' }}/>
      </Stack>
    </AppLockGate>
  </NavigationTheme>;
}

function Themed() {
  const { session } = useAppState();
  return <ThemeProvider accent={session?.district.brand?.accent}><Navigator/></ThemeProvider>;
}

export default function RootLayout() {
  return <SafeAreaProvider>
    <AppStateProvider><Themed/></AppStateProvider>
  </SafeAreaProvider>;
}
