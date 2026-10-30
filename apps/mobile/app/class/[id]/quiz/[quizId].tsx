import { useLocalSearchParams } from 'expo-router';
import { ClientGate } from '../../../../src/ui/ClientGate';
import { QuizScreen } from '../../../../src/screens/Course';
import { param } from '../../../../src/params';

/** `/class/<offeringId>/quiz/<quizId>`: take a quiz and see results. */
export default function QuizRoute() {
  const params = useLocalSearchParams();
  return <ClientGate>{(client) => <QuizScreen client={client} offeringId={param(params.id)} quizId={param(params.quizId)}/>}</ClientGate>;
}
