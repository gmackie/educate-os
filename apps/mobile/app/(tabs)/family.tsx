import { useDetailNavigation } from '../../src/navigation';
import { ClientGate } from '../../src/ui/ClientGate';
import { Today } from '../../src/screens/Today';

/** A family's home: their children, unread updates and school news (Today's guardian view). */
export default function FamilyTab() {
  const { navigate, changeTab } = useDetailNavigation();
  return <ClientGate>{(client, me) => <Today client={client} me={me} navigate={navigate} changeTab={changeTab} showAi={false}/>}</ClientGate>;
}
