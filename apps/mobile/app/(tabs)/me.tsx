import { useAppState } from '../../src/state/app-state';
import { Me } from '../../src/screens/Me';

export default function MeTab() {
  const { session } = useAppState();
  if (!session) return null;
  return <Me/>;
}
