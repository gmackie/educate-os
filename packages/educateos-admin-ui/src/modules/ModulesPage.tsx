import { useState } from "react";
import { Banner, Text } from "@cloudflare/kumo";
import { CheckCircle } from "@phosphor-icons/react";
import { LoadState } from "../app/LoadState.tsx";
import { useLoad } from "../app/useLoad.ts";
import type { DistrictConfigState } from "../app/useDistrictConfig.ts";
import { ChangeReview, type ProposedChange } from "./ChangeReview.tsx";
import { surveyClasses } from "./classSurvey.ts";
import { ModulesEditor } from "./ModulesEditor.tsx";
import { RevisionHistory } from "./RevisionHistory.tsx";
import { SetupPanel } from "./SetupPanel.tsx";
import { VisibleClasses } from "./VisibleClasses.tsx";

/**
 * Modules and activation: the capability packs and the classes that see them, a dry-run preview
 * of every change, activation as a new configuration version, the version history with roll back,
 * and turning a single class off.
 */
export const ModulesPage = ({ state }: { state: DistrictConfigState }) => {
  const [review, setReview] = useState<ProposedChange>();
  const [notice, setNotice] = useState<string>();
  const head = state.config.status === "ready" ? state.config.data.head : undefined;
  const me = useLoad("me", (client) => client.call("me.get"));
  const classes = useLoad(`classes:${head?.revision.id ?? "none"}`, async (client) => head === undefined ? [] : surveyClasses(client, head.desired));

  const preview = (change: ProposedChange) => {
    setNotice(undefined);
    setReview(change);
  };

  return (
    <div className="flex flex-col gap-6">
      <Text as="h2" variant="heading" size="lg">Modules and activation</Text>
      {notice !== undefined && <Banner icon={<CheckCircle weight="fill" />} title={notice} />}
      <LoadState loaded={state.config} what="the district configuration">
        {(config) => {
          if (review !== undefined) {
            return (
              <ChangeReview
                change={review}
                expectedHeadRevisionId={config.head?.revision.id}
                onCancel={() => setReview(undefined)}
                onApplied={(revision, changes) => {
                  state.onApplied(revision, changes);
                  setNotice(`${review.applyLabel}: version ${(config.head?.number ?? 0) + 1} is now in force.`);
                  setReview(undefined);
                }}
              />
            );
          }
          if (config.head === undefined) {
            return <LoadState loaded={me} what="your district">{(m) => <SetupPanel districtId={m.districtId} onPreview={preview} />}</LoadState>;
          }
          const current = config.head;
          return (
            <LoadState loaded={classes} what="the district's classes" onRetry={classes.reload}>
              {(list) => (
                <div className="flex flex-col gap-8">
                  <ModulesEditor key={current.revision.id} head={current} classes={list} onPreview={preview} />
                  <VisibleClasses head={current} classes={list} onPreview={preview} />
                  <RevisionHistory versions={config.versions} onPreview={preview} />
                </div>
              )}
            </LoadState>
          );
        }}
      </LoadState>
    </div>
  );
};
