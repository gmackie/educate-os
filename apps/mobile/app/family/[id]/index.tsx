import { useLocalSearchParams } from 'expo-router';
import { useDetailNavigation } from '../../../src/navigation';
import { ClientGate } from '../../../src/ui/ClientGate';
import { FamilyChild } from '../../../src/screens/Classes';
import { param } from '../../../src/params';

export default function FamilyChildRoute() {
  const id = param(useLocalSearchParams().id);
  const { navigate } = useDetailNavigation();
  return <ClientGate>{(client) => <FamilyChild client={client} studentId={id} navigate={navigate}/>}</ClientGate>;
}
