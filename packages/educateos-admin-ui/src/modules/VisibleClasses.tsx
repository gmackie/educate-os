import { Button, Table, Text } from "@cloudflare/kumo";
import type { DirectoryNames } from "../app/labels.ts";
import type { ConfigVersion } from "../app/useDistrictConfig.ts";
import { documentFromDesired, withRolloutClasses } from "../configDocument.ts";
import type { ProposedChange } from "./ChangeReview.tsx";
import type { ClassSummary } from "./classSurvey.ts";

interface VisibleClassesProps {
  /** The version in force. */
  head: ConfigVersion;
  /** Every class, with whether modules are visible to it now. */
  classes: readonly ClassSummary[];
  /** The district's class and school names. */
  names: DirectoryNames;
  /** Called with the change to preview. */
  onPreview: (change: ProposedChange) => void;
}

/**
 * The classes the configuration turns modules on for, each with a way to take it out of the
 * rollout alone. Taking a class out previews who it reaches first; students' work is kept. The
 * configuration does not yet limit what a class can use (see `ModulesPage`), so this says what the
 * configuration records, never that a class can or cannot use EducateOS.
 */
export const VisibleClasses = ({ head, classes, names, onPreview }: VisibleClassesProps) => {
  const visible = classes.filter((c) => c.visibleNow).toSorted((a, b) => names.offering(a.offeringId).localeCompare(names.offering(b.offeringId)));
  const revoke = (target: ClassSummary) => onPreview({
    title: `Preview: turn modules off for ${names.offering(target.offeringId)}`,
    document: documentFromDesired(withRolloutClasses(head.desired, visible.filter((c) => c !== target).map((c) => c.offeringId))),
    applyLabel: "Turn off for this class",
    appliedMessage: `Modules turned off for ${names.offering(target.offeringId)}`,
    removesAccess: true,
  });

  return (
    <section aria-labelledby="visible-heading" className="flex flex-col gap-3">
      <Text as="h3" variant="heading" id="visible-heading">Classes with modules on</Text>
      {visible.length === 0 ? <Text variant="secondary">The configuration turns modules on for no class yet.</Text> : (
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">Classes the configuration turns modules on for</caption>
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
                  <Table.Cell>{names.offering(c.offeringId)}</Table.Cell>
                  <Table.Cell>{names.school(c.schoolId)}</Table.Cell>
                  <Table.Cell>{c.students}</Table.Cell>
                  <Table.Cell>{c.staff}</Table.Cell>
                  <Table.Cell>
                    <Button variant="secondary-destructive" size="sm" aria-label={`Turn off for ${names.offering(c.offeringId)}`} onClick={() => revoke(c)}>
                      Turn off
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
      <Text variant="secondary" size="sm">Turning a class off takes it out of the rollout. Nothing students made is deleted.</Text>
    </section>
  );
};
