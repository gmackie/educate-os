import { useLocalSearchParams } from 'expo-router';
import { useDetailNavigation } from '../../../src/navigation';
import { ClientGate } from '../../../src/ui/ClientGate';
import { AssignmentScreen } from '../../../src/screens/Assignments';
import { TeacherAssignment } from '../../../src/screens/TeacherReview';
import { param } from '../../../src/params';

/** `/assignment/<id>?offering=<offeringId>` (the class is optional for deep links). */
export default function AssignmentRoute() {
  const params = useLocalSearchParams();
  const id = param(params.id), offering = param(params.offering);
  const { navigate } = useDetailNavigation();
  return <ClientGate>{(client, me) => me.kind === 'staff'
    ? <TeacherAssignment client={client} assignmentId={id} offeringId={offering} navigate={navigate}/>
    : <AssignmentScreen client={client} assignmentId={id} offeringId={offering} navigate={navigate}/>}</ClientGate>;
}
