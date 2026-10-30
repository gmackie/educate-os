import { useLocalSearchParams } from 'expo-router';
import { ClientGate } from '../../../../src/ui/ClientGate';
import { QuizScreen } from '../../../../src/screens/Course';
import { TeacherQuiz } from '../../../../src/screens/Teaching';
import { param } from '../../../../src/params';

/** `/class/<offeringId>/quiz/<quizId>`: take a quiz and see results, or (staff) grade and release it. */
export default function QuizRoute() {
  const params = useLocalSearchParams();
  return <ClientGate>{(client, me) => me.kind === 'staff'
    ? <TeacherQuiz client={client} offeringId={param(params.id)} quizId={param(params.quizId)}/>
    : <QuizScreen client={client} offeringId={param(params.id)} quizId={param(params.quizId)}/>}</ClientGate>;
}
