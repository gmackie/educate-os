import { Breadcrumbs, Text } from "@cloudflare/kumo";
import { useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { coursePath, quizPath } from "../router.tsx";
import { AttemptResultView } from "./AttemptResultView.tsx";

/** One of the student's finished attempts at a quiz, as the quiz lets them see it. */
export const QuizResultPage = ({ offeringId, quizId, attemptId }: { offeringId: string; quizId: string; attemptId: string }) => {
  const [result, reload] = useQuery(`quiz-result:${offeringId}:${attemptId}`, (client) => client.call("student.quizAttemptResult", { params: { offeringId, attemptId } }));
  if (result.status === "loading") return <LoadingSkeleton label="Loading your results" lines={4} />;
  if (result.status === "error") return <ErrorState error={result.error} title="We couldn't open these results" onRetry={reload} />;
  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs>
        <Breadcrumbs.Link href="/">Home</Breadcrumbs.Link>
        <Breadcrumbs.Separator />
        <Breadcrumbs.Link href={coursePath(offeringId)}>{result.data.courseTitle || "Class"}</Breadcrumbs.Link>
        <Breadcrumbs.Separator />
        <Breadcrumbs.Link href={quizPath(offeringId, quizId)}>{result.data.title}</Breadcrumbs.Link>
        <Breadcrumbs.Separator />
        <Breadcrumbs.Current>{`Attempt ${result.data.number}`}</Breadcrumbs.Current>
      </Breadcrumbs>
      <Text variant="heading" size="lg" as="h1">{`${result.data.title}: attempt ${result.data.number}`}</Text>
      <AttemptResultView result={result.data} />
    </div>
  );
};
