import { useId, useState, useSyncExternalStore } from "react";
import { Badge, Button, DropdownMenu, Text } from "@cloudflare/kumo";
import { ArrowsLeftRightIcon, CaretDownIcon, CaretRightIcon, PlusIcon, UserMinusIcon } from "@phosphor-icons/react";
import type { CleverSection, CleverSideStore, CleverStudent } from "./cleverSide.ts";

interface CleverSideProps {
  side: CleverSideStore;
  /** The district administrator, who runs the sync, and whether the visitor is them now. */
  admin: { name: string; current: boolean };
  /** Takes the visitor to the admin console's Roster sync screen, as the administrator. */
  onOpenRosterSync: () => void;
  /** Whether the panel is open, when its owner decides, as the Clever tour's "Show me" opens it. */
  expansion?: { open: boolean; onOpenChange: (open: boolean) => void };
}

/**
 * The demo's Clever side (SCHO-277): a panel beside whichever app the visitor is in, where they
 * change the district in Clever as its SIS would (add a student to a section, withdraw one, move
 * one between sections) and see what is still waiting for a sync. It sits beside the app, never
 * over it, and collapses to its toggle.
 */
export const CleverSide = ({ side, admin, onOpenRosterSync, expansion }: CleverSideProps) => {
  const [openHere, setOpenHere] = useState(false);
  const open = expansion?.open ?? openHere;
  const setOpen = expansion?.onOpenChange ?? setOpenHere;
  const { sections, pending, ready } = useSyncExternalStore(side.subscribe, side.getSnapshot);
  const [announcement, setAnnouncement] = useState("");
  const panelId = useId();
  const headingId = useId();

  const change = (make: () => { summary: string }) => {
    const made = make();
    setAnnouncement(`${made.summary}. It is pending in Clever until the next sync.`);
  };
  const openRosterSync = admin.current ? "Open Roster sync" : `Open Roster sync as ${admin.name}`;

  return (
    <aside
      aria-label="Clever side"
      className={`flex flex-col border-kumo-line bg-kumo-elevated max-lg:order-first max-lg:border-b lg:border-l ${open ? "lg:w-96" : ""}`}
    >
      <div className="flex items-center gap-2 p-2">
        <Button
          size="sm"
          variant="ghost"
          icon={open ? <CaretDownIcon aria-hidden /> : <CaretRightIcon aria-hidden />}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
        >
          Clever side
        </Button>
        {pending.length > 0 && <Badge variant="secondary">{`${pending.length} pending`}</Badge>}
      </div>
      <span role="status" className="sr-only">{announcement}</span>
      {open && (
        <section id={panelId} aria-labelledby={headingId} className="flex flex-col gap-4 px-4 pb-6">
          <div className="flex flex-col gap-1">
            <Text as="h2" variant="heading3" id={headingId}>Change the district in Clever (simulated)</Text>
            <Text size="sm" variant="secondary">
              Make the changes a district's student information system would send to Clever. Cedar Valley picks them up on its next roster sync, as it would from Clever.
            </Text>
          </div>
          {!ready ? (
            <div className="flex flex-col items-start gap-2">
              <Text size="sm">Cedar Valley hasn't synced from Clever yet. Run its first sync in Roster sync, then change its roster here.</Text>
              <Button size="sm" variant="primary" onClick={onOpenRosterSync}>{openRosterSync}</Button>
            </div>
          ) : (
            <>
              <section aria-labelledby={`${headingId}-pending`} className="flex flex-col items-start gap-2">
                <Text as="h3" bold size="sm" id={`${headingId}-pending`}>Pending in Clever</Text>
                {pending.length === 0 ? (
                  <Text size="sm" variant="secondary">Nothing waiting: Cedar Valley has every change Clever has.</Text>
                ) : (
                  <>
                    <ul className="flex list-disc flex-col gap-1 pl-5">
                      {pending.map((p) => <li key={p.id}><Text size="sm">{p.summary}</Text></li>)}
                    </ul>
                    <Text size="sm">Run a delta sync in Roster sync to bring these in.</Text>
                    <Button size="sm" variant="primary" onClick={onOpenRosterSync}>{openRosterSync}</Button>
                  </>
                )}
              </section>
              {sections.map((section) => (
                <SectionInClever
                  key={section.id}
                  section={section}
                  side={side}
                  onAdd={() => change(() => side.addStudent(section.id))}
                  onWithdraw={(student) => change(() => side.withdraw(student.id))}
                  onMove={(student, to) => change(() => side.move(student.id, section.id, to.id))}
                />
              ))}
            </>
          )}
        </section>
      )}
    </aside>
  );
};

interface SectionInCleverProps {
  section: CleverSection;
  side: CleverSideStore;
  onAdd: () => void;
  onWithdraw: (student: CleverStudent) => void;
  onMove: (student: CleverStudent, to: CleverSection) => void;
}

/** One section as Clever lists it: its students, each with what can change, and a way to add one. */
const SectionInClever = ({ section, side, onAdd, onWithdraw, onMove }: SectionInCleverProps) => {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 rounded-lg border border-kumo-line p-3">
      <Text as="h3" bold size="sm" id={headingId}>{section.name}</Text>
      <ul className="flex flex-col gap-1">
        {section.students.map((student) => {
          const targets = side.moveTargets(student.id, section.id);
          const withdrawable = side.canWithdraw(student.id);
          return (
            <li key={student.id} className="flex items-center justify-between gap-2">
              <Text size="sm">{student.name}</Text>
              {(targets.length > 0 || withdrawable) && (
                <DropdownMenu>
                  <DropdownMenu.Trigger render={<Button size="xs" variant="ghost" aria-label={`Change ${student.name} in ${section.name}`}>Change</Button>} />
                  <DropdownMenu.Content>
                    {targets.map((to) => (
                      <DropdownMenu.Item key={to.id} icon={ArrowsLeftRightIcon} onClick={() => onMove(student, to)}>{`Move to ${to.name}`}</DropdownMenu.Item>
                    ))}
                    {withdrawable && (
                      <DropdownMenu.Item variant="danger" icon={UserMinusIcon} onClick={() => onWithdraw(student)}>Withdraw from the district</DropdownMenu.Item>
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu>
              )}
            </li>
          );
        })}
      </ul>
      <div>
        <Button size="xs" variant="secondary" icon={<PlusIcon aria-hidden />} aria-label={`Add a new student to ${section.name}`} onClick={onAdd}>
          Add a new student
        </Button>
      </div>
    </section>
  );
};
