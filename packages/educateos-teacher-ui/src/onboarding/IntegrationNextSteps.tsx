import { LayerCard, Text } from "@cloudflare/kumo";
import { routeHref } from "../route.ts";
import { useDistrictShell } from "../shell.tsx";

/** How deeply the teacher wants to bring an existing lesson into EducateOS. */
export type IntegrationLevel = "reuse" | "activity" | "connect";

/** Next steps for the teacher's chosen level, without granting access or publishing anything. */
export const IntegrationNextSteps = ({ level, offeringId }: { level: IntegrationLevel; offeringId: string }) => {
  const hasAi = useDistrictShell()?.school.features.ai === true;
  return (
    <section aria-labelledby="next-heading" className="flex flex-col gap-3">
      <h2 id="next-heading"><Text variant="heading" as="span">Your next steps</Text></h2>
      <LayerCard className="flex flex-col gap-3 p-4">
        {level === "reuse" && (
          <>
            <h3><Text bold as="span">Start small and keep teaching</Text></h3>
            <Text>Review your first resource, or check the draft modules from your course export. Keep the source material so you can compare what came across.</Text>
            <p><a href={routeHref({ screen: "resources", offeringId })}>Review your resources</a></p>
            <p><a href={routeHref({ screen: "modules", offeringId })}>Open your class modules</a></p>
          </>
        )}
        {level === "activity" && (
          <>
            <h3><Text bold as="span">Make one lesson ready for students</Text></h3>
            <ol className="list-decimal space-y-2 pl-6">
              <li>Review and approve the resources you want students to use.</li>
              <li>Create an activity with directions, learning goals, a rubric and the AI help you allow.</li>
              <li>Preview it as a student, then publish and assign when you are ready.</li>
            </ol>
            <p><a href={routeHref({ screen: "create", offeringId })}>Create your first activity</a></p>
            <Text variant="secondary">The activity builder uses the text and resources you choose. It does not automatically convert an imported lesson.</Text>
          </>
        )}
        {level === "connect" && (
          <>
            <h3><Text bold as="span">Connect only what your lesson needs</Text></h3>
            <Text>With your school administrator, confirm the source class, who may access it, which data stays in each system and where official grades belong. Roster sync and grade return need the school's configured integration; an account connection alone does not enable them.</Text>
            {hasAi ? (
              <p><a href="/ai/">Open the AI workspace to explore available connections</a></p>
            ) : (
              <Text variant="secondary">Ask your school administrator which connections are available. You can bring over materials while that setup is arranged.</Text>
            )}
            <Text variant="secondary">A custom classroom app can build on approved resources and authorized connections in the AI workspace. Generated apps need teacher review and a student-safe access model before classroom use.</Text>
          </>
        )}
      </LayerCard>
    </section>
  );
};
