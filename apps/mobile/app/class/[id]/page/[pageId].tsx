import { useLocalSearchParams } from 'expo-router';
import { ClientGate } from '../../../../src/ui/ClientGate';
import { PageScreen } from '../../../../src/screens/Course';
import { param } from '../../../../src/params';

/** `/class/<offeringId>/page/<pageId>`: a module page. */
export default function PageRoute() {
  const params = useLocalSearchParams();
  return <ClientGate>{(client, me) => <PageScreen client={client} offeringId={param(params.id)} pageId={param(params.pageId)}
    role={me.kind === 'staff' ? 'teacher' : 'student'}/>}</ClientGate>;
}
