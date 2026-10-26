import type { RouteResponse } from "@educateos/api-client";

type Submitted = RouteResponse<"teacher.submittedContent">;
type ActivityContent = RouteResponse<"teacher.getActivity">["content"];

/** One piece of submitted work and the name the review shows it under. */
export interface LabelledWork {
  submitted: Submitted;
  label: string;
}

/**
 * Submitted work in the order of the activity's steps, each named by its step. A submission keeps
 * its items in a canonical order that says nothing about steps, so the step is found the way
 * Learning Home saves it: work for a step is titled "<assignment title>: <step title>". Work that
 * matches no step follows, under its own title, or numbered when it has none.
 */
export const workInStepOrder = (work: readonly Submitted[], assignmentTitle: string, content: ActivityContent | undefined): LabelledWork[] => {
  const steps = (content?.steps ?? []).filter((step) => step.response.kind !== "none");
  const prefix = `${assignmentTitle}: `;
  const stepOf = (title: string | undefined) => (title === undefined ? -1 : steps.findIndex((step) => `${prefix}${step.title}`.slice(0, 200) === title));
  const placed = work.map((submitted) => ({ submitted, step: stepOf(submitted.title) }));
  const matched = placed.filter((p) => p.step >= 0).toSorted((a, b) => a.step - b.step);
  const rest = placed.filter((p) => p.step < 0);
  return [
    ...matched.map(({ submitted, step }) => ({ submitted, label: steps[step]!.title })),
    ...rest.map(({ submitted }, index) => {
      const title = submitted.title?.startsWith(prefix) ? submitted.title.slice(prefix.length) : submitted.title;
      return { submitted, label: title === undefined || title.trim() === "" ? `Work ${matched.length + index + 1}` : title };
    }),
  ];
};
