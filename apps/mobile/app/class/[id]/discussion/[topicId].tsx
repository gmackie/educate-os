import { useLocalSearchParams } from 'expo-router';
import { ClientGate } from '../../../../src/ui/ClientGate';
import { DiscussionScreen } from '../../../../src/screens/Course';
import { param } from '../../../../src/params';

/** `/class/<offeringId>/discussion/<topicId>`: a discussion thread. */
export default function DiscussionRoute() {
  const params = useLocalSearchParams();
  return <ClientGate>{(client, me) => <DiscussionScreen client={client} offeringId={param(params.id)} topicId={param(params.topicId)}
    role={me.kind === 'staff' ? 'teacher' : 'student'}/>}</ClientGate>;
}
