import { Button, Table, Text } from "@cloudflare/kumo";
import { className, schoolName } from "../app/labels.ts";
import type { ConfigVersion } from "../app/useDistrictConfig.ts";
import { documentFromDesired, withRolloutClasses } from "../configDocument.ts";
import type { ProposedChange } from "./ChangeReview.tsx";
import type { ClassSummary } from "./classSurvey.ts";

interface VisibleClassesProps {
  /** The version in force. */
  head: ConfigVersion;
  /** Every class, with whether modules are visible to it now. */
  classes: readonly ClassSummary[];
  /** Called with the change to preview. */
  onPreview: (change: ProposedChange) => void;
}

/**
 * The classes using EducateOS now, each with a way to turn it off for that class alone. Turning a
 * class off previews who loses access first; students' work is kept.
 */
export const VisibleClasses = ({ head, classes, onPreview }: VisibleClassesProps) => {
  const visible = classes.filter((c) => c.visibleNow);
  const revoke = (target: ClassSummary) => onPreview({
    title: `Preview: turn off EducateOS for ${className(target.offeringId)}`,
    document: documentFromDesired(withRolloutClasses(head.desired, visible.filter((c) => c !== target).map((c) => c.offeringId))),
    applyLabel: "Turn off for this class",
    removesAccess: true,
  });

  return (
    <section aria-labelledby="visible-heading" className="flex flex-col gap-3">
      <Text as="h3" variant="heading" id="visible-heading">Classes using EducateOS</Text>
      {visible.length === 0 ? <Text variant="secondary">No class can see EducateOS modules yet.</Text> : (
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">Classes modules are visible to now</caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Class</Table.Head>
                <Table.Head>School</Table.Head>
                <Table.Head>Students</Table.Head>
                <Table.Head>Staff</Table.Head>
                <Table.Head><span className="sr-only">Actions</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {visible.map((c) => (
                <Table.Row key={c.offeringId}>
                  <Table.Cell>{className(c.offeringId)}</Table.Cell>
                  <Table.Cell>{schoolName(c.schoolId)}</Table.Cell>
                  <Table.Cell>{c.students}</Table.Cell>
                  <Table.Cell>{c.staff}</Table.Cell>
                  <Table.Cell>
                    <Button variant="secondary-destructive" size="sm" onClick={() => revoke(c)}>
                      Turn off for {className(c.offeringId)}
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
      <Text variant="secondary" size="sm">Turning a class off removes live access to EducateOS modules there. Nothing students made is deleted.</Text>
    </section>
  );
};
