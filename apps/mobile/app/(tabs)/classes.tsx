import { useDetailNavigation } from '../../src/navigation';
import { ClientGate } from '../../src/ui/ClientGate';
import { Classes } from '../../src/screens/Classes';

export default function ClassesTab() {
  const { navigate } = useDetailNavigation();
  return <ClientGate>{(client, me) => <Classes client={client} me={me} navigate={navigate}/>}</ClientGate>;
}
