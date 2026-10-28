import { useDetailNavigation } from '../../src/navigation';
import { ClientGate } from '../../src/ui/ClientGate';
import { CalendarScreen } from '../../src/screens/Calendar';

export default function AgendaTab() {
  const { navigate } = useDetailNavigation();
  return <ClientGate>{(client) => <CalendarScreen client={client} navigate={navigate}/>}</ClientGate>;
}
