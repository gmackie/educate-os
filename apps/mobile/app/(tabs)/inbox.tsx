import { useDetailNavigation } from '../../src/navigation';
import { useAppState } from '../../src/state/app-state';
import { ClientGate } from '../../src/ui/ClientGate';
import { Inbox } from '../../src/screens/Inbox';

export default function InboxTab() {
  const { navigate } = useDetailNavigation();
  const { refreshUnread } = useAppState();
  return <ClientGate>{(client) => <Inbox client={client} navigate={navigate} onChange={refreshUnread}/>}</ClientGate>;
}
