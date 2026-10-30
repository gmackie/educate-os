import { useDetailNavigation } from '../../src/navigation';
import { useAppState } from '../../src/state/app-state';
import { ClientGate } from '../../src/ui/ClientGate';
import { Inbox } from '../../src/screens/Inbox';
import { FamilyInbox } from '../../src/screens/FamilyFeed';

export default function InboxTab() {
  const { navigate } = useDetailNavigation();
  const { refreshUnread } = useAppState();
  return <ClientGate>{(client, me) => me.kind === 'guardian'
    ? <FamilyInbox client={client} navigate={navigate}/>
    : <Inbox client={client} navigate={navigate} onChange={refreshUnread}/>}</ClientGate>;
}
