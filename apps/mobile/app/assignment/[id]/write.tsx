import { useLocalSearchParams, useRouter } from 'expo-router';
import { ClientGate } from '../../../src/ui/ClientGate';
import { WriteResponse } from '../../../src/screens/Assignments';
import { param } from '../../../src/params';

export default function WriteRoute() {
  const params = useLocalSearchParams();
  const router = useRouter();
  return <ClientGate>{(client) => <WriteResponse client={client} assignmentId={param(params.id)}
    offeringId={param(params.offering)} onComplete={() => router.back()}/>}</ClientGate>;
}
