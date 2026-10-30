import { useLocalSearchParams } from 'expo-router';
import { useDetailNavigation } from '../../../src/navigation';
import { ClientGate } from '../../../src/ui/ClientGate';
import { StudentClass, TeacherClass } from '../../../src/screens/Classes';
import { param } from '../../../src/params';

/** `/class/<offeringId>`: the student or teacher view, by who is signed in. */
export default function ClassRoute() {
  const id = param(useLocalSearchParams().id);
  const { navigate } = useDetailNavigation();
  return <ClientGate>{(client, me) => me.kind === 'staff'
    ? <TeacherClass client={client} offeringId={id} navigate={navigate}/>
    : <StudentClass client={client} offeringId={id} navigate={navigate}/>}</ClientGate>;
}
