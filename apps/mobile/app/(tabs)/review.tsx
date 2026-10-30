import { useDetailNavigation } from '../../src/navigation';
import { ClientGate } from '../../src/ui/ClientGate';
import { ReviewQueue } from '../../src/screens/TeacherReview';

export default function ReviewTab() {
  const { navigate } = useDetailNavigation();
  return <ClientGate>{(client) => <ReviewQueue client={client} navigate={navigate}/>}</ClientGate>;
}
