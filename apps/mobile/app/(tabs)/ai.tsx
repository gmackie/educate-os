import { useRouter } from 'expo-router';
import { useAppState } from '../../src/state/app-state';
import { Workspace } from '../../src/screens/Workspace';
import { Page, Placeholder } from '../../src/ui/Primitives';

export default function AiTab() {
  const { session } = useAppState();
  const router = useRouter();
  if (!session) return null;
  if (session.district.features?.ai === false) {
    return <Page><Placeholder title="AI isn't turned on here"
      message="Your school hasn't enabled the AI workspace. Your classes, calendar and messages still work."/></Page>;
  }
  return <Workspace session={session} onReturn={() => router.push('/welcome')}/>;
}
