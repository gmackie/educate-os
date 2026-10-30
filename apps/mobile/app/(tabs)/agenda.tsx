import { useDetailNavigation } from '../../src/navigation';
import { ClientGate } from '../../src/ui/ClientGate';
import { FamilyAgenda } from '../../src/screens/FamilyFeed';

/** The family's agenda: what their children have due (the district calendar covers only the caller's own classes). */
export default function AgendaTab() {
  const { navigate } = useDetailNavigation();
  return <ClientGate>{(client) => <FamilyAgenda client={client} navigate={navigate}/>}</ClientGate>;
}
