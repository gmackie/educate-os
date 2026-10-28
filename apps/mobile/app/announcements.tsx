import { ClientGate } from '../src/ui/ClientGate';
import { Announcements } from '../src/screens/Assignments';

export default function AnnouncementsRoute() {
  return <ClientGate>{(client) => <Announcements client={client}/>}</ClientGate>;
}
