import { Badge, Empty, Link, Surface, Text } from "@cloudflare/kumo";
import { Navigate } from "@tanstack/react-router";
import type { RouteResponse } from "@educateos/api-client";
import { useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { formatDateTime } from "../labels.ts";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { HomeLearningNav } from "./HomeLearningNav.tsx";
import { STATE_BADGE, STATE_HELP, STATE_LABEL, STRAND_LABEL, TRACK_LABEL } from "./labels.ts";
import { LearnerSwitcher } from "./LearnerSwitcher.tsx";
import { HOME_PATH, progressPath, sessionPath } from "./paths.ts";
import { useFamily } from "./useFamily.ts";

type Progress = RouteResponse<"family.progress">;
type SkillView = Progress["skills"][number];

const PATTERN_TEXT = {
  "counted-start-mark": "Has been counting the starting number as a jump.",
  "jumped-wrong-way": "Has jumped the wrong way more than once.",
  "letters-out-of-order": "Has had the right letters in the wrong order more than once.",
} as const;

/** One skill: its state, and the evidence behind it in plain counts. */
const SkillRow = ({ skill }: { skill: SkillView }) => (
  <li className="flex flex-col gap-1 border-b border-kumo-hairline py-3 last:border-b-0">
    <span className="flex flex-wrap items-center gap-2">
      <span className="font-semibold">{skill.title}</span>
      <Badge variant={STATE_BADGE[skill.state]}>{STATE_LABEL[skill.state]}</Badge>
    </span>
    <Text variant="secondary" size="sm">{skill.description}</Text>
    {skill.responses === 0 ? null : (
      <Text size="sm">
        {`${skill.independent} of ${skill.responses} answers right on the first try without help, over ${skill.sessions} ${skill.sessions === 1 ? "session" : "sessions"}`}
        {skill.fromChecks > 0 ? `; ${skill.fromChecks} from checks` : ""}
        {skill.helped > 0 ? `; ${skill.helped} with a hint or your help` : ""}
        {skill.adultObserved > 0 ? `; ${skill.adultObserved} you listened to and recorded` : ""}
        {skill.adultPresented > 0 ? `; ${skill.adultPresented} after you said the sounds` : ""}
        {skill.lastPracticedAt === undefined ? "." : `. Last practiced ${formatDateTime(skill.lastPracticedAt)}.`}
      </Text>
    )}
    {skill.pattern === undefined ? null : <Text size="sm">{PATTERN_TEXT[skill.pattern]}</Text>}
  </li>
);

const ProgressBody = ({ progress }: { progress: Progress }) => (
  <>
    {(["reading", "math"] as const).map((track) => {
      const skills = progress.skills.filter((s) => s.track === track);
      const strands = [...new Set(skills.map((s) => s.strand))];
      return (
        <Surface key={track} className="rounded-xl border border-kumo-hairline p-5">
          <section aria-labelledby={`progress-${track}`} className="flex flex-col gap-3">
            <h2 id={`progress-${track}`} className="text-xl font-semibold">{TRACK_LABEL[track]}</h2>
            {strands.map((strand) => (
              <div key={strand} className="flex flex-col">
                <h3 className="font-semibold text-kumo-subtle">{STRAND_LABEL[strand] ?? strand}</h3>
                <ul>{skills.filter((s) => s.strand === strand).map((skill) => <SkillRow key={skill.skillId} skill={skill} />)}</ul>
              </div>
            ))}
          </section>
        </Surface>
      );
    })}
    <section aria-labelledby="progress-sessions" className="flex flex-col gap-3">
      <h2 id="progress-sessions" className="text-xl font-semibold">Recent practice</h2>
      {progress.sessions.length === 0 ? <Text variant="secondary">No practice yet.</Text> : (
        <ul className="flex flex-col gap-3">
          {progress.sessions.map((session) => (
            <li key={session.id}>
              <Surface className="flex flex-col gap-1 rounded-xl border border-kumo-hairline p-4">
                <span className="flex flex-wrap items-center gap-2">
                  <Link href={sessionPath(progress.learner.id, session.id)} className="font-semibold">{session.title}</Link>
                  <Badge variant="neutral">{TRACK_LABEL[session.track]}</Badge>
                  {session.mode === "check" ? <Badge variant="info">Check</Badge> : null}
                  {session.completedAt === undefined ? <Badge variant="warning">Not finished</Badge> : null}
                  <time dateTime={session.startedAt} className="text-kumo-subtle">{formatDateTime(session.startedAt)}</time>
                </span>
                <Text>{session.note}</Text>
              </Surface>
            </li>
          ))}
        </ul>
      )}
    </section>
  </>
);

/** One child's progress: each skill's practice state with the evidence behind it, and recent sessions. */
export const ProgressPage = ({ learnerId }: { learnerId: string }) => {
  const [home] = useFamily();
  const [progress, reload] = useQuery(`family-progress:${learnerId}`, (api) => api.call("family.progress", { params: { learnerId } }));
  if (home.status === "ready" && home.data.family === null) return <Navigate to={HOME_PATH} replace />;
  const name = progress.status === "ready" ? progress.data.learner.displayName : undefined;
  return (
    <div className="flex flex-col gap-6">
      <PageHeading>{name === undefined ? "Progress" : `${name}'s progress`}</PageHeading>
      <HomeLearningNav />
      {home.status === "ready" && home.data.family !== null ? <LearnerSwitcher family={home.data.family} current={learnerId} pathFor={progressPath} /> : null}
      <details className="rounded-xl border border-kumo-hairline p-4">
        <summary className="cursor-pointer font-semibold">What these labels mean</summary>
        <dl className="mt-2 flex flex-col gap-2">
          {(Object.keys(STATE_LABEL) as (keyof typeof STATE_LABEL)[]).map((state) => (
            <div key={state}><dt className="font-semibold">{STATE_LABEL[state]}</dt><dd>{STATE_HELP[state]}</dd></div>
          ))}
        </dl>
      </details>
      {progress.status === "loading" ? <LoadingSkeleton label="Loading progress" /> : null}
      {progress.status === "error" ? <ErrorState error={progress.error} title="We couldn't load progress" onRetry={reload} /> : null}
      {progress.status === "ready" ? <ProgressBody progress={progress.data} /> : null}
    </div>
  );
};

/** Progress for the family's first child. */
export const FirstProgressPage = () => {
  const [home, reload] = useFamily();
  if (home.status === "loading") return <LoadingSkeleton label="Loading progress" />;
  if (home.status === "error") return <ErrorState error={home.error} title="We couldn't load progress" onRetry={reload} />;
  const first = home.data.family?.learners[0];
  if (home.data.family === null) return <Navigate to={HOME_PATH} replace />;
  if (first === undefined) return <Empty title="No children yet" description="Add a child from Children and PIN." />;
  return <Navigate to={progressPath(first.id)} replace />;
};
