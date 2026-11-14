import { useState } from "react";
import { Button, Select, Text } from "@cloudflare/kumo";
import { Clock, Trash } from "@phosphor-icons/react";
import { Loading } from "../Loading.tsx";
import { Problem } from "../Problem.tsx";
import { useAction } from "../modules/useAction.ts";
import type { ExtendedTime, Quiz, QuizAccommodations } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { extendedTimeLabel } from "./quizText.ts";

/** The extended time a teacher may give, as an IEP or Section 504 plan usually words it. */
const CHOICES: readonly ExtendedTime[] = [1.25, 1.5, 2, 3, 4, "unlimited"];

type Student = { principalId: string; displayName: string };

/** Who has extended time, and, for those who may change it, giving and removing it. */
const ExtendedTimeEditor = ({ quiz, accommodations, students, onChanged }: {
  quiz: Quiz;
  accommodations: QuizAccommodations;
  /** The class's actively enrolled students. */
  students: readonly Student[];
  onChanged: () => void;
}) => {
  const [studentId, setStudentId] = useState<string | null>(null);
  const [extendedTime, setExtendedTime] = useState<ExtendedTime>(1.5);
  const action = useAction(onChanged);
  const limit = quiz.settings.timeLimitMinutes;
  const names = new Map(accommodations.names.map((n) => [n.principalId as string, n.displayName]));
  const chosen = students.find((s) => s.principalId === studentId);

  const set = (student: Student, value: ExtendedTime | null) => action.run(`set:${student.principalId}`, async (client) => {
    await client.call("teacher.setQuizAccommodation", { params: { offeringId: quiz.offeringId, quizId: quiz.id }, body: { studentId: student.principalId, extendedTime: value } });
    return value === null ? `Removed ${student.displayName}'s extended time.` : `${student.displayName} has ${extendedTimeLabel(value, limit).toLowerCase()} on ${quiz.title}.`;
  });

  return (
    <>
      {accommodations.accommodations.length === 0
        ? <Text as="p">No student has extended time on this quiz.</Text>
        : (
          <ul aria-label="Students with extended time" className="flex flex-col gap-2">
            {accommodations.accommodations.map((a) => {
              const student = { principalId: a.studentId as string, displayName: names.get(a.studentId) ?? "A student" };
              return (
                <li key={a.studentId} className="flex flex-wrap items-center gap-2">
                  <span>{`${student.displayName}: ${extendedTimeLabel(a.extendedTime, limit)}`}</span>
                  {accommodations.canManage && (
                    <Button size="sm" variant="ghost" icon={<Trash aria-hidden />} loading={action.running(`set:${student.principalId}`)} disabled={action.busy}
                      onClick={() => void set(student, null)}>
                      {`Remove ${student.displayName}'s extended time`}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      {accommodations.canManage && (
        <form
          aria-label="Give extended time"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosen !== undefined) void set(chosen, extendedTime);
          }}
        >
          <Select<string | null>
            label="Student"
            placeholder="Choose a student"
            value={studentId}
            renderValue={(value) => students.find((s) => s.principalId === value)?.displayName ?? "Choose a student"}
            onValueChange={setStudentId}
          >
            {students.map((s) => <Select.Option key={s.principalId} value={s.principalId}>{s.displayName}</Select.Option>)}
          </Select>
          <Select<ExtendedTime>
            label="Time"
            value={extendedTime}
            renderValue={(value) => extendedTimeLabel(value, limit)}
            onValueChange={(value) => { if (value !== null) setExtendedTime(value); }}
          >
            {CHOICES.map((choice) => <Select.Option key={String(choice)} value={choice}>{extendedTimeLabel(choice, limit)}</Select.Option>)}
          </Select>
          <Button type="submit" variant="primary" loading={chosen !== undefined && action.running(`set:${chosen.principalId}`)} disabled={chosen === undefined || action.busy}>
            Give extended time
          </Button>
        </form>
      )}
      {action.state.status === "failed" && <Problem error={action.state.error} />}
    </>
  );
};

/**
 * Students' extended time on one quiz (SCHO-383, WCAG 2.2.1). The district holds it apart from the
 * quiz and shows it only to the class's teachers and district administrators; each student sees
 * only their own time.
 */
export const ExtendedTimeSection = ({ quiz }: { quiz: Quiz }) => {
  const data = useLoad(`quiz-accommodations:${quiz.offeringId}:${quiz.id}`, async (client) => {
    const [accommodations, roster] = await Promise.all([
      client.call("teacher.quizAccommodations", { params: { offeringId: quiz.offeringId, quizId: quiz.id } }),
      client.call("teacher.roster", { params: { offeringId: quiz.offeringId } }),
    ]);
    const students = roster.filter((entry) => entry.enrollment.role === "student" && entry.enrollment.status === "active")
      .map((entry): Student => ({ principalId: entry.enrollment.principalId, displayName: entry.displayName }));
    return { accommodations, students };
  });

  return (
    <section aria-labelledby="extended-time" className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4">
      <h2 id="extended-time" className="flex items-center gap-2"><Clock aria-hidden /><Text variant="heading" as="span">Extended time</Text></h2>
      <Text variant="secondary" as="p">
        Give a student more time than the class's time limit, as their IEP or 504 plan sets it. Only the class's teachers and district administrators see this; each student sees only their own time. An attempt in progress gets the extra time at once.
      </Text>
      {quiz.settings.timeLimitMinutes === undefined && <Text variant="secondary" size="sm" as="p">This quiz has no time limit, so extended time takes effect only if you set one.</Text>}
      {data.status === "loading" && <Loading label="Loading extended time…" />}
      {data.status === "error" && <Problem error={data.error} onRetry={data.reload} />}
      {data.status === "ready" && <ExtendedTimeEditor quiz={quiz} accommodations={data.data.accommodations} students={data.data.students} onChanged={data.reload} />}
    </section>
  );
};
