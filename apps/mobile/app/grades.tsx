import { useDetailNavigation } from '../src/navigation';
import { ClientGate } from '../src/ui/ClientGate';
import { StudentGrades } from '../src/screens/Assignments';

export default function GradesRoute() {
  const { navigate } = useDetailNavigation();
  return <ClientGate>{(client) => <StudentGrades client={client} navigate={navigate}/>}</ClientGate>;
}
