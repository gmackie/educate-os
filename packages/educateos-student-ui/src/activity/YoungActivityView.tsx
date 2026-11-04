import { useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Banner, Breadcrumbs, Button, Surface } from "@cloudflare/kumo";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BookOpenTextIcon,
  CheckCircleIcon,
  CircleIcon,
  EarIcon,
  FlagCheckeredIcon,
  InfoIcon,
  MicrophoneIcon,
  PaintBrushIcon,
  PencilSimpleIcon,
  RocketLaunchIcon,
  TableIcon,
  UploadSimpleIcon,
  type Icon,
} from "@phosphor-icons/react";
import { AskAi } from "../AskAi.tsx";
import { formatDateTime } from "../labels.ts";
import type { ActivityStep, AssignedActivity } from "../model.ts";
import { PrivacyNote } from "../PrivacyNote.tsx";
import { ReadAloudButton } from "../readAloud/ReadAloudButton.tsx";
import { SpokenText } from "../readAloud/SpokenText.tsx";
import { stopReading } from "../readAloud/speech.ts";
import { useReadAloud } from "../readAloud/useReadAloud.ts";
import { coursePath } from "../router.tsx";
import type { ActivityWork } from "./activityWork.ts";
import { AiHelpSlot } from "./AiHelpSlot.tsx";
import { FeedbackSection } from "./FeedbackSection.tsx";
import { ResourceList } from "./ResourceList.tsx";
import { SentenceFrames } from "./SentenceFrames.tsx";
import { SubmitSection } from "./SubmitSection.tsx";
import { WorkItem } from "./WorkItem.tsx";
import { workModeFor } from "./workMode.ts";

/** The picture beside a step's title, by what the step asks for. */
const stepIcon = (step: ActivityStep): Icon => {
  const response = step.response;
  switch (response.kind) {
    case "none":
      return step.sources.length > 0 ? BookOpenTextIcon : EarIcon;
    case "writing":
      return PencilSimpleIcon;
    case "dataset":
      return TableIcon;
    case "artifact":
      return response.artifactType === "audio" ? MicrophoneIcon : response.artifactType === "image" ? PaintBrushIcon : UploadSimpleIcon;
  }
};

const big = "min-h-14 px-6 text-xl";

/** One page of the activity: a large heading that takes focus when the page opens, then its content. */
const Page = ({ id, current, icon: PageIcon, title, headingRef, children }: {
  id: string;
  current: boolean;
  icon: Icon;
  title: string;
  headingRef: (element: HTMLHeadingElement | null) => void;
  children: ReactNode;
}) => (
  <section aria-labelledby={id} hidden={!current} className="flex flex-col gap-6">
    <h2 id={id} ref={headingRef} tabIndex={-1} className="flex items-center gap-3 text-3xl font-semibold outline-none">
      <PageIcon aria-hidden weight="duotone" size={48} className="shrink-0" />
      {title}
    </h2>
    {children}
  </section>
);

/** Text read aloud prominently: large type with "Read to me" beside it. */
const ReadAloudBlock = ({ text, label }: { text: string; label: string }) => {
  const control = useReadAloud(text, label);
  return (
    <div className="flex flex-col items-start gap-4">
      <SpokenText control={control} className="p-1 text-2xl leading-relaxed" />
      <ReadAloudButton control={control} prominent />
    </div>
  );
};

/**
 * An activity for young learners (K-2): a start page, then one step a page with large type, its
 * prompt read aloud on request, its sentence starters and its work, then a finish page with "I'm
 * done!" and the teacher's feedback. Every page stays mounted, hidden when not shown, so unsaved
 * work and a recording in progress survive moving between steps. Moving to a page moves focus to
 * its heading and stops any reading.
 */
export const YoungActivityView = ({ offeringId, courseName, entry, work }: {
  offeringId: string;
  courseName: string;
  entry: AssignedActivity;
  work: ActivityWork;
}) => {
  const { assignment, activity } = entry;
  const { content } = activity;
  const steps = content.steps;
  const last = steps.length + 1;
  const [page, setPage] = useState(0);
  const headings = useRef(new Map<number, HTMLHeadingElement>());
  const headingRef = (index: number) => (element: HTMLHeadingElement | null) => {
    if (element === null) headings.current.delete(index);
    else headings.current.set(index, element);
  };

  const go = (next: number) => {
    stopReading();
    // The page must be shown before its heading can take focus.
    flushSync(() => setPage(next));
    headings.current.get(next)?.focus();
  };

  const position = page === 0 ? "Start" : page === last ? "Finish" : `Step ${page} of ${steps.length}`;
  const savedCount = steps.filter((step) => work.saved.has(step.id)).length;
  const workCount = steps.filter((step) => step.response.kind !== "none").length;

  return (
    <div className="flex flex-col gap-6" data-presentation="young">
      <Breadcrumbs>
        <Breadcrumbs.Link href="/">Home</Breadcrumbs.Link>
        <Breadcrumbs.Separator />
        <Breadcrumbs.Link href={coursePath(offeringId)}>{courseName}</Breadcrumbs.Link>
        <Breadcrumbs.Separator />
        <Breadcrumbs.Current>{assignment.title}</Breadcrumbs.Current>
      </Breadcrumbs>

      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-bold">{assignment.title}</h1>
        <p className="text-kumo-subtle">
          Due <time dateTime={assignment.dueAt}>{formatDateTime(assignment.dueAt)}</time>
        </p>
      </div>

      {/* Where the student is: read as text, shown as a row of dots. */}
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xl font-semibold">{position}</p>
        <ol aria-hidden className="flex items-center gap-1">
          {Array.from({ length: last + 1 }, (_, index) => (
            <li key={index}>
              {index < page ? <CheckCircleIcon weight="fill" size={20} /> : index === page ? <CircleIcon weight="fill" size={20} /> : <CircleIcon size={20} />}
            </li>
          ))}
        </ol>
      </div>

      {work.readOnly ? (
        <Banner variant="secondary" icon={<InfoIcon weight="fill" />} title="This class has finished" description="You can look at your work, but not change it." />
      ) : null}

      <Surface className="rounded-2xl border border-kumo-hairline p-6">
        <Page id="young-start" current={page === 0} icon={RocketLaunchIcon} title="Let's get started" headingRef={headingRef(0)}>
          <ReadAloudBlock text={content.overview} label="what this activity is about" />
          {content.resources.length > 0 || content.codex.some((codexEntry) => codexEntry.kind === "note") ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-xl font-semibold">Look at these</h3>
              <ResourceList activity={activity} />
            </div>
          ) : null}
          <AskAi context={{ kind: "assignment", id: assignment.id }} />
          <AiHelpSlot assigned={{ assignment, activity }} />
        </Page>

        {steps.map((step, index) => {
          const mode = workModeFor(step, { drawing: true });
          return (
            <Page key={step.id} id={`young-step-${step.id}`} current={page === index + 1} icon={stepIcon(step)} title={step.title} headingRef={headingRef(index + 1)}>
              <ReadAloudBlock text={step.prompt} label={`step ${index + 1}, ${step.title}`} />
              {step.sentenceFrames === undefined ? null : <SentenceFrames frames={step.sentenceFrames} />}
              {mode === undefined ? null : (
                <WorkItem
                  step={step}
                  mode={mode}
                  title={work.titleFor(step)}
                  draftKey={work.draftKeyFor(step)}
                  saved={work.saved.get(step.id)}
                  readOnly={work.readOnly}
                  young
                  ensureWorkspace={work.ensureWorkspace}
                  onSaved={(view) => work.onSaved(step.id, view)}
                />
              )}
            </Page>
          );
        })}

        <Page id="young-finish" current={page === last} icon={FlagCheckeredIcon} title="All done?" headingRef={headingRef(last)}>
          {workCount === 0 ? (
            <p className="text-2xl">There's nothing to hand in. Great listening!</p>
          ) : (
            <>
              <p className="text-2xl">{savedCount === workCount ? "You saved all your work." : `You saved ${savedCount} of ${workCount}. Go back to finish the rest.`}</p>
              <ul className="flex flex-col gap-2 text-xl">
                {steps.filter((step) => step.response.kind !== "none").map((step) => (
                  <li key={step.id} className="flex items-center gap-2">
                    {work.saved.has(step.id) ? <CheckCircleIcon aria-hidden weight="fill" size={28} className="text-kumo-success" /> : <CircleIcon aria-hidden size={28} />}
                    <span>{step.title}</span>
                    <span className="sr-only">{work.saved.has(step.id) ? "(saved)" : "(not saved yet)"}</span>
                  </li>
                ))}
              </ul>
              {work.readOnly ? null : <SubmitSection assignment={assignment} work={work.submittable} unsaved={work.unsaved} young onSubmitted={work.onSubmitted} />}
            </>
          )}
          <div className="flex flex-col gap-2">
            <h3 className="text-xl font-semibold">What your teacher said</h3>
            <FeedbackSection assignmentId={assignment.id} refreshKey={work.feedbackKey} />
          </div>
          <PrivacyNote scope="course" />
        </Page>
      </Surface>

      <nav aria-label="Steps" className="flex flex-wrap items-center justify-between gap-4">
        {page === 0 ? <span /> : (
          <Button size="lg" className={big} icon={<ArrowLeftIcon aria-hidden weight="bold" size={24} />} onClick={() => go(page - 1)}>
            Back
          </Button>
        )}
        {page === last ? null : (
          <Button variant="primary" size="lg" className={big} onClick={() => go(page + 1)}>
            {page === 0 ? "Let's start" : page === steps.length ? "Finish" : "Next"}
            <ArrowRightIcon aria-hidden weight="bold" size={24} />
          </Button>
        )}
      </nav>
    </div>
  );
};
