import { useState } from "react";
import { Checkbox, LayerCard, Radio, Text } from "@cloudflare/kumo";
import { classLabel } from "../classes/classLabel.ts";
import { CartridgeImport } from "../modules/CartridgeImport.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { ImportResourceForm } from "../resources/ImportResourceForm.tsx";
import { navigate, routeHref } from "../route.ts";
import type { TeachingOffering } from "../types.ts";
import { IntegrationNextSteps, type IntegrationLevel } from "./IntegrationNextSteps.tsx";

const MATERIALS = [
  { id: "web", label: "Websites and online resources", description: "Lesson links, articles, open textbooks, videos and interactive tools." },
  { id: "documents", label: "Documents, slides and worksheets", description: "Lesson plans, PDFs, Word documents, presentations, rubrics and handouts." },
  { id: "course", label: "A course export", description: "A Common Cartridge (.imscc) exported from a learning system such as Canvas." },
  { id: "classroom", label: "Google Classroom or another learning system", description: "Existing classes, assignments, rosters and grades." },
  { id: "other", label: "Other classroom tools", description: "Spreadsheets, calendars, forms, question banks and classroom apps." },
] as const;

type Material = (typeof MATERIALS)[number]["id"];

/** A teacher's starting point for bringing existing materials into a district-provisioned class. */
export const ClassroomSetupPage = ({ teaching }: { teaching: TeachingOffering }) => {
  const offeringId = teaching.offering.id;
  const [materials, setMaterials] = useState<Material[]>([]);
  const [level, setLevel] = useState<IntegrationLevel>("reuse");

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>{`Classroom setup · ${classLabel(teaching)}`}</PageHeading>
      <Text>Start with one lesson you already teach. Bring the materials that make it work, then choose how you want to use them here. You can return to this page whenever you have more to add.</Text>
      <LayerCard className="flex flex-col gap-3 p-4">
        <h2><Text variant="heading" as="span">Your class is already here</Text></h2>
        <Text variant="secondary">Your school manages this class and its enrollment. Importing teaching materials does not change the roster.</Text>
        <p><a href={routeHref({ screen: "roster", offeringId })}>Check your class roster</a></p>
      </LayerCard>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2"><Text variant="heading" as="span">1. What are you bringing?</Text></legend>
        <Text variant="secondary">Choose everything you use. Each option explains what can come over today.</Text>
        {MATERIALS.map((material) => (
          <div key={material.id} className="flex flex-col gap-1">
            <Checkbox
              label={material.label}
              aria-describedby={`material-${material.id}-help`}
              checked={materials.includes(material.id)}
              onCheckedChange={(checked) => setMaterials((previous) => checked === true
                ? [...previous, material.id]
                : previous.filter((id) => id !== material.id))}
            />
            <Text variant="secondary" size="sm" as="span"><span id={`material-${material.id}-help`}>{material.description}</span></Text>
          </div>
        ))}
      </fieldset>
      <Radio.Group
        legend="2. How would you like to start?"
        appearance="card"
        value={level}
        onValueChange={(value) => setLevel(value as IntegrationLevel)}
        description="This chooses your next steps. It does not connect accounts, change permissions or publish work."
      >
        <Radio.Item value="reuse" label="Bring my materials" description="Reuse resources and course content while keeping your current teaching routine." />
        <Radio.Item value="activity" label="Build an EducateOS activity" description="Turn a lesson into student steps, learning goals and a rubric you review before assigning." />
        <Radio.Item value="connect" label="Connect my existing tools" description="Explore account connections and school-managed roster or grade integrations." />
      </Radio.Group>
      <section aria-labelledby="materials-heading" className="flex flex-col gap-4">
        <h2 id="materials-heading"><Text variant="heading" as="span">3. Bring over your first lesson</Text></h2>
        {materials.length === 0 && <Text variant="secondary">Choose a material above to see where to start. You can also create an activity from scratch below.</Text>}
        {materials.includes("web") && (
          <LayerCard className="flex flex-col gap-3 p-4">
            <h3><Text bold as="span">Start with a web resource</Text></h3>
            <Text variant="secondary">Use a page EducateOS can open without signing in. We check it before you decide whether to approve it for this class. A video or interactive tool stays a link; importing its page does not copy its content or connect its account.</Text>
            <ImportResourceForm offeringId={offeringId} onImported={(item) => navigate({ screen: "resource", offeringId, itemId: item.id })} />
          </LayerCard>
        )}
        {materials.includes("documents") && (
          <LayerCard className="flex flex-col gap-3 p-4">
            <h3><Text bold as="span">Use documents, slides and worksheets</Text></h3>
            <Text>Direct document uploads are not available in Teacher Studio yet. Copy text you have permission to reuse into an activity, or add a public web version through Resources. Files behind a school sign-in need an authorized connection.</Text>
            <p><a href={routeHref({ screen: "create", offeringId })}>Create an activity from your lesson text</a></p>
          </LayerCard>
        )}
        {materials.includes("course") && (
          <LayerCard className="flex flex-col gap-3 p-4">
            <h3><Text bold as="span">Preview a course export</Text></h3>
            <Text variant="secondary">Export a Common Cartridge (.imscc) from your existing system, up to 5 MB. Preview the pages, links, discussions and supported quiz questions, including anything that cannot come across. Imported modules stay unpublished until you publish them. This is a one-time copy; later source changes do not sync.</Text>
            <CartridgeImport offeringId={offeringId} onImported={() => navigate({ screen: "modules", offeringId })} />
          </LayerCard>
        )}
        {materials.includes("classroom") && (
          <LayerCard className="flex flex-col gap-3 p-4">
            <h3><Text bold as="span">Keep your existing classroom system</Text></h3>
            <Text>Google Classroom account access and school-managed roster or grade integrations are separate connections. Your school administrator can confirm what is enabled and link the right class. Selecting this option does not import assignments, students or grades.</Text>
            <Text variant="secondary">For a one-time content move, use a Common Cartridge export if your system provides one. Rosters, past submissions and grade history are not included in that import.</Text>
          </LayerCard>
        )}
        {materials.includes("other") && (
          <LayerCard className="flex flex-col gap-3 p-4">
            <h3><Text bold as="span">Bring the teaching routine behind the tool</Text></h3>
            <Text>Start with what students should do: investigate a dataset, answer a prompt, practice a skill or complete a project. Use your existing directions to create an activity and choose the resources students need.</Text>
            <Text variant="secondary">Spreadsheets, forms and question banks do not have a direct importer here yet. Preserve their source files and answer keys; automatic conversion and ongoing updates need a supported adapter.</Text>
          </LayerCard>
        )}
      </section>
      <IntegrationNextSteps level={level} offeringId={offeringId} />
    </div>
  );
};
