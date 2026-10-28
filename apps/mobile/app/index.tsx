import { View } from 'react-native';
import { Redirect } from 'expo-router';
import { useAppState } from '../src/state/app-state';
import { homeTab } from '../src/tabs';
import { usePalette } from '../src/ui/theme-context';
import { Loading } from '../src/ui/Primitives';

export default function Index() {
  const { booting, session, revoked, role, client, principal, principalError } = useAppState();
  const palette = usePalette();
  // Wait for the school to say who this is, so a family lands on Family rather than Today.
  if (booting || (session && client?.available && !principal && !principalError && !revoked)) {
    return <View style={{ flex: 1, backgroundColor: palette.background, justifyContent: 'center' }}>
      <Loading label="Preparing EducateOS…"/></View>;
  }
  if (revoked) return <Redirect href="/signed-out"/>;
  if (!session) return <Redirect href="/welcome"/>;
  return <Redirect href={('/' + homeTab(role)) as never}/>;
}
