import { useAppState } from '../../src/state/app-state';
import { useDetailNavigation } from '../../src/navigation';
import { ClientGate } from '../../src/ui/ClientGate';
import { Today } from '../../src/screens/Today';

export default function TodayTab() {
  const { navigate, changeTab } = useDetailNavigation();
  const { session } = useAppState();
  return <ClientGate>{(client, me) => <Today client={client} me={me} navigate={navigate} changeTab={changeTab}
    showAi={session?.district.features?.ai !== false}/>}</ClientGate>;
}
