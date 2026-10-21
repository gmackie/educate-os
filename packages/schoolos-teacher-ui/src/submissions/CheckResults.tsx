import { useState } from "react";
import { Badge, Banner, Button, Text } from "@cloudflare/kumo";
import { CheckCircle, Play, XCircle } from "@phosphor-icons/react";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Problem } from "../Problem.tsx";
import type { CheckRun } from "../types.ts";

/**
 * The rubric's automatic checks on this submission. Running them is deterministic: the same work
 * and rubric give the same result, so running again returns the same report rather than a new
 * opinion. Their scores are suggestions the teacher may adopt.
 */
export const CheckResults = ({ submissionId, hasRubric, run, onRun }: {
  submissionId: string;
  hasRubric: boolean;
  run: CheckRun | undefined;
  onRun: (run: CheckRun) => void;
}) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const [state, setState] = useState<{ status: "idle" | "running" } | { status: "failed"; error: unknown }>({ status: "idle" });

  const start = async () => {
    setState({ status: "running" });
    try {
      const result = await client.call("teacher.runCi", { params: { submissionId }, body: {} });
      setState({ status: "idle" });
      onRun(result);
      announce(result.run.state === "completed" ? "Automatic checks finished." : result.run.state === "failed" ? "Automatic checks couldn't finish." : "Automatic checks are running.");
    } catch (error) {
      setState({ status: "failed", error });
    }
  };

  const report = run?.run.report;
  return (
    <section aria-labelledby="checks-heading" className="flex flex-col gap-3">
      <h2 id="checks-heading"><Text variant="heading" as="span">Automatic checks</Text></h2>
      {hasRubric ? (
        <div>
          <Button icon={<Play aria-hidden />} loading={state.status === "running"} onClick={() => void start()}>
            {run === undefined ? "Run checks" : "Check again"}
          </Button>
        </div>
      ) : <Text variant="secondary">This activity has no rubric, so there are no automatic checks.</Text>}
      {state.status === "failed" && <Problem error={state.error} />}
      {run !== undefined && (run.run.state === "queued" || run.run.state === "running") && (
        <Text variant="secondary">The checks are still running. Press “Check again” in a moment.</Text>
      )}
      {run?.run.state === "failed" && <Banner variant="error" title="The checks couldn't finish" description={run.run.error?.message ?? "Try again later."} />}
      {report !== undefined && (
        <>
          <Text>{report.summary.text}</Text>
          <ul className="flex flex-col gap-3">
            {report.criteria.map((criterion) => (
              <li key={criterion.criterionId} className="flex flex-col gap-2">
                <Text bold as="span">{criterion.title}</Text>
                <ul className="flex flex-col gap-2">
                  {criterion.checks.flatMap((check) => check.evidence.map((evidence, index) => (
                    <li key={`${check.checkId}-${index}`} className="flex items-start gap-2 rounded border border-kumo-line p-2">
                      {evidence.passed === false ? <XCircle aria-hidden className="mt-1 shrink-0" /> : <CheckCircle aria-hidden className="mt-1 shrink-0" />}
                      <span className="flex flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge variant="teal">Automatic check</Badge>
                          {evidence.passed !== undefined && <Badge variant={evidence.passed ? "success" : "warning"}>{evidence.passed ? "Met" : "Not met"}</Badge>}
                          {check.visibility === "teacher-only" && <Badge variant="neutral">Only you see this check</Badge>}
                        </span>
                        <Text as="span">{evidence.observation}</Text>
                        <Text variant="secondary" size="sm" as="span">{evidence.explanation}</Text>
                      </span>
                    </li>
                  )))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};
