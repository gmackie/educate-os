import { useRouter } from 'expo-router';
import { useAppState } from '../../src/state/app-state';
import { tabHref } from '../../src/navigation';
import { homeTab } from '../../src/tabs';
import { Workspace } from '../../src/screens/Workspace';
import { Page, Placeholder } from '../../src/ui/Primitives';

export default function AiTab() {
  const { session, role } = useAppState();
  const router = useRouter();
  if (!session) return null;
  if (session.district.features?.ai === false) {
    return <Page><Placeholder title="AI isn't turned on here"
      message="Your school hasn't enabled the AI workspace. Your classes, calendar and messages still work."/></Page>;
  }
  // Leaving the workspace goes home, not to the school picker.
  return <Workspace session={session} onReturn={() => router.navigate(tabHref(homeTab(role)) as never)}/>;
}
