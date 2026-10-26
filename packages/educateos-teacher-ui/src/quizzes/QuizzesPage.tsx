import { useState } from "react";
import { Badge, Button, Empty, Input, Table, Text } from "@cloudflare/kumo";
import { ListChecks, Plus } from "@phosphor-icons/react";
import { classLabel } from "../classes/classLabel.ts";
import { Loading } from "../Loading.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import { useAction } from "../modules/useAction.ts";
import { navigate, routeHref } from "../route.ts";
import type { TeachingOffering } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { formatDateTime } from "../dates.ts";

/** Starting a quiz: its title. Everything else is set in the builder it opens into. */
const NewQuizForm = ({ offeringId }: { offeringId: string }) => {
  const [title, setTitle] = useState("");
  const action = useAction(() => {});
  return (
    <form
      aria-label="New quiz"
      className="flex flex-wrap items-end gap-3 rounded-lg border border-kumo-hairline p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run("create", async (client) => {
          const quiz = await client.call("teacher.createQuiz", { params: { offeringId }, body: { title: title.trim() } });
          navigate({ screen: "quiz", offeringId, quizId: quiz.id });
          return `Started ${quiz.title}. Add its questions and settings, then publish it.`;
        });
      }}
    >
      <div className="min-w-64 grow">
        <Input label="Quiz title" placeholder="Poetry terms check" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
      </div>
      <Button type="submit" variant="primary" icon={<Plus aria-hidden />} loading={action.running("create")} disabled={title.trim() === "" || action.busy}>
        Create quiz
      </Button>
      {action.state.status === "failed" && <Problem error={action.state.error} />}
    </form>
  );
};

/** A class's quizzes: each with where it stands and what needs the teacher, and starting a new one. */
export const QuizzesPage = ({ teaching }: { teaching: TeachingOffering }) => {
  const offeringId = teaching.offering.id;
  const listing = useLoad(`quizzes:${offeringId}`, (client) => client.call("teacher.listQuizzes", { params: { offeringId } }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>{`Quizzes · ${classLabel(teaching)}`}</PageHeading>
      {listing.status === "loading" && <Loading label="Loading the quizzes…" />}
      {listing.status === "error" && <Problem error={listing.error} onRetry={listing.reload} />}
      {listing.status === "ready" && (
        <>
          {listing.data.canManage && <NewQuizForm offeringId={offeringId} />}
          {listing.data.quizzes.length === 0
            ? <Empty icon={<ListChecks size={32} aria-hidden />} title="No quizzes yet" description="Create a quiz, add its questions, and publish it to the class." />
            : (
              <Table>
                <caption className="sr-only">Quizzes</caption>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Quiz</Table.Head>
                    <Table.Head>Status</Table.Head>
                    <Table.Head>Submitted</Table.Head>
                    <Table.Head>Needs grading</Table.Head>
                    <Table.Head>Scores released</Table.Head>
                    <Table.Head>Results</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {listing.data.quizzes.map(({ quiz, submitted, needsGrading, lastReleasedAt }) => (
                    <Table.Row key={quiz.id}>
                      <Table.Cell><a href={routeHref({ screen: "quiz", offeringId, quizId: quiz.id })}>{quiz.title}</a></Table.Cell>
                      <Table.Cell>
                        <Badge variant={quiz.status === "published" ? "success" : "neutral"}>{quiz.status === "published" ? "Published" : "Draft"}</Badge>
                      </Table.Cell>
                      <Table.Cell>{submitted}</Table.Cell>
                      <Table.Cell>{needsGrading > 0 ? <Badge variant="warning">{String(needsGrading)}</Badge> : "0"}</Table.Cell>
                      <Table.Cell>{lastReleasedAt === undefined ? <Text variant="secondary" as="span">Not yet</Text> : formatDateTime(lastReleasedAt)}</Table.Cell>
                      <Table.Cell><a href={routeHref({ screen: "quiz-results", offeringId, quizId: quiz.id })}>{`Results for ${quiz.title}`}</a></Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            )}
        </>
      )}
    </div>
  );
};
