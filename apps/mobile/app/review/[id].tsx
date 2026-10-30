import { useLocalSearchParams } from 'expo-router';
import { ClientGate } from '../../src/ui/ClientGate';
import { useLoad } from '../../src/hooks/useLoad';
import type { DistrictClient } from '../../src/api/client';
import { TeacherReview } from '../../src/screens/TeacherReview';
import { Page, QueryState } from '../../src/ui/Primitives';
import { param } from '../../src/params';

type Artifact = { artifactId: string; type: string };

function readArtifacts(value: string): Artifact[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((a): a is Artifact => !!a && typeof a.artifactId === 'string' && typeof a.type === 'string').slice(0, 20);
  } catch { return null; }
}

/** A deep link names only the submission (and its assignment); look up what was submitted. */
function LookUp({ client, submissionId, assignmentId }: { client: DistrictClient; submissionId: string; assignmentId: string }) {
  const [state, retry] = useLoad('review-lookup:' + submissionId, async () => {
    if (!assignmentId) throw new Error('Open this submission from its assignment.');
    const submission = (await client.teacherSubmissions(assignmentId)).find((s) => s.id === submissionId);
    if (!submission) throw new Error('This submission is no longer available.');
    // The name comes from the class roster; a failed lookup still opens the work.
    const { assignment } = await client.teacherAssignment(assignmentId);
    const roster = await client.teacherRoster(assignment.offeringId).catch(() => []);
    const name = roster.find((r) => r.enrollment.principalId === submission.studentPrincipalId)?.displayName ?? 'Student';
    return { name, artifacts: submission.items.map((item) => ({ artifactId: item.artifactId, type: item.artifactType })) };
  });
  return state.status === 'ready'
    ? <TeacherReview client={client} submissionId={submissionId} studentName={state.value.name} artifacts={state.value.artifacts}/>
    : <Page><QueryState state={state} retry={retry}>{() => null}</QueryState></Page>;
}

/** `/review/<submissionId>?assignment=<id>`: grade and comment on one submission. */
export default function ReviewRoute() {
  const params = useLocalSearchParams();
  const id = param(params.id), artifacts = readArtifacts(param(params.artifacts));
  return <ClientGate>{(client) => artifacts
    ? <TeacherReview client={client} submissionId={id} studentName={param(params.student) || 'Student'} artifacts={artifacts}/>
    : <LookUp client={client} submissionId={id} assignmentId={param(params.assignment)}/>}</ClientGate>;
}
