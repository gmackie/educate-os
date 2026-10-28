import { useLocalSearchParams } from 'expo-router';
import { ClientGate } from '../../../../src/ui/ClientGate';
import { FamilyClass } from '../../../../src/screens/Classes';
import { param } from '../../../../src/params';

export default function FamilyClassRoute() {
  const params = useLocalSearchParams();
  return <ClientGate>{(client) => <FamilyClass client={client} studentId={param(params.id)} offeringId={param(params.offering)}/>}</ClientGate>;
}
