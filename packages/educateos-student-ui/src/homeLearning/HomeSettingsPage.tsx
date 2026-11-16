import { useState } from "react";
import { Button, ClipboardText, Input, Surface, Switch, Text } from "@cloudflare/kumo";
import { DownloadSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { Navigate } from "@tanstack/react-router";
import { useAnnounce } from "../AppContext.tsx";
import { messageFor, useApi } from "../api.tsx";
import { formatDateTime } from "../labels.ts";
import { useRefreshSignIn } from "./signInRefresh.ts";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { NoticeText, type FamilyNoticeView } from "./FamilyNotice.tsx";
import { HomeLearningNav } from "./HomeLearningNav.tsx";
import { avatarName } from "./labels.ts";
import { LearnerFields, NEW_LEARNER, type LearnerDraft } from "./LearnerFields.tsx";
import { HOME_PATH } from "./paths.ts";
import { useFamily, type FamilyView } from "./useFamily.ts";

/** Saves a JSON document as a file the browser downloads. */
const download = (name: string, value: unknown) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  URL.revokeObjectURL(url);
};

const Children = ({ family, onChanged }: { family: FamilyView; onChanged: () => void }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [draft, setDraft] = useState<LearnerDraft>(NEW_LEARNER);
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <Surface className="flex flex-col gap-4 rounded-xl border border-kumo-hairline p-5">
      <section aria-labelledby="settings-children" className="flex flex-col gap-4">
        <h2 id="settings-children" className="text-lg font-semibold">Children</h2>
        <ul className="flex flex-col gap-3">
          {family.learners.map((learner) => (
            <li key={learner.id} className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <span role="img" aria-label={avatarName(learner.avatar)} className="text-2xl">{learner.avatar}</span>
                {learner.displayName}
              </span>
              {removing === learner.id ? (
                <span className="flex flex-wrap items-center gap-2" role="group" aria-label={`Remove ${learner.displayName}?`}>
                  <Text size="sm">{`This deletes all of ${learner.displayName}'s practice. It can't be undone.`}</Text>
                  <Button size="sm" variant="destructive" onClick={() => {
                    api.call("family.removeLearner", { params: { learnerId: learner.id }, body: {} }).then(() => {
                      announce(`Removed ${learner.displayName}`);
                      setRemoving(undefined);
                      onChanged();
                    }, (caught: unknown) => setError(messageFor(caught)));
                  }}>{`Remove ${learner.displayName} and their practice`}</Button>
                  <Button size="sm" onClick={() => setRemoving(undefined)}>Keep</Button>
                </span>
              ) : (
                <Button size="sm" variant="secondary-destructive" icon={<TrashIcon aria-hidden />} onClick={() => setRemoving(learner.id)}>{`Remove ${learner.displayName}`}</Button>
              )}
            </li>
          ))}
        </ul>
        <form className="flex flex-col gap-4 border-t border-kumo-hairline pt-4" aria-label="Add a child" onSubmit={(event) => {
          event.preventDefault();
          setError(undefined);
          api.call("family.addLearner", { body: { ...draft, displayName: draft.displayName.trim(), avatar: draft.avatar as never } }).then(() => {
            announce(`Added ${draft.displayName.trim()}`);
            setDraft(NEW_LEARNER);
            onChanged();
          }, (caught: unknown) => setError(messageFor(caught)));
        }}>
          <h3 className="font-semibold">Add a child</h3>
          <LearnerFields idPrefix="add" value={draft} onChange={setDraft} />
          <Button type="submit" className="self-start" disabled={draft.displayName.trim() === ""}>Add child</Button>
        </form>
        {error === undefined ? null : <p role="alert" className="text-kumo-danger">{error}</p>}
      </section>
    </Surface>
  );
};

/**
 * The family's grown-ups: who they are, invitations for another one, and removing one (or leaving).
 * Every grown-up sees and changes everything, so an invitation link goes only to the person meant
 * to join.
 */
const GrownUps = ({ family, onChanged }: { family: FamilyView; onChanged: () => void }) => {
  const api = useApi();
  const announce = useAnnounce();
  const refresh = useRefreshSignIn();
  const [link, setLink] = useState<{ link: string; expiresAt: string } | undefined>(undefined);
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const nameOf = (adult: FamilyView["adults"][number]) => adult.you ? "You" : adult.displayName ?? "Another grown-up";
  return (
    <Surface className="flex flex-col gap-4 rounded-xl border border-kumo-hairline p-5">
      <section aria-labelledby="settings-adults" className="flex flex-col gap-4">
        <h2 id="settings-adults" className="text-lg font-semibold">Grown-ups</h2>
        <Text>Every grown-up here sees the children's plans and progress and can change them, start practice, and use the family PIN.</Text>
        <ul className="flex flex-col gap-3">
          {family.adults.map((adult) => (
            <li key={adult.principalId} className="flex flex-wrap items-center justify-between gap-3">
              <span>{nameOf(adult)}</span>
              {family.adults.length < 2 ? null : removing === adult.principalId ? (
                <span className="flex flex-wrap items-center gap-2" role="group" aria-label={adult.you ? "Leave this family?" : `Remove ${nameOf(adult)}?`}>
                  <Button size="sm" variant="destructive" onClick={() => {
                    api.call("family.removeAdult", { params: { principalId: adult.principalId }, body: {} }).then(() => {
                      announce(adult.you ? "You left the family" : `Removed ${nameOf(adult)}`);
                      setRemoving(undefined);
                      if (adult.you) refresh();
                      else onChanged();
                    }, (caught: unknown) => setError(messageFor(caught)));
                  }}>{adult.you ? "Leave this family" : `Remove ${nameOf(adult)}`}</Button>
                  <Button size="sm" onClick={() => setRemoving(undefined)}>Cancel</Button>
                </span>
              ) : (
                <Button size="sm" variant="secondary-destructive" onClick={() => setRemoving(adult.principalId)}>{adult.you ? "Leave" : `Remove ${nameOf(adult)}`}</Button>
              )}
            </li>
          ))}
        </ul>
        {family.invitations.length === 0 ? null : (
          <ul className="flex flex-col gap-2" aria-label="Open invitations">
            {family.invitations.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3">
                <span>{`Invitation, usable until ${formatDateTime(invitation.expiresAt)}`}</span>
                <Button size="sm" variant="ghost" onClick={() => {
                  api.call("family.revokeInvitation", { params: { invitationId: invitation.id }, body: {} }).then(() => {
                    announce("Invitation withdrawn");
                    setLink(undefined);
                    onChanged();
                  }, (caught: unknown) => setError(messageFor(caught)));
                }}>Withdraw</Button>
              </li>
            ))}
          </ul>
        )}
        {link === undefined ? (
          <Button className="self-start" onClick={() => {
            setError(undefined);
            api.call("family.inviteAdult", { body: {} }).then((made) => {
              setLink(made);
              announce("Invitation link made");
              onChanged();
            }, (caught: unknown) => setError(messageFor(caught)));
          }}>Invite another grown-up</Button>
        ) : (
          <div className="flex flex-col gap-2">
            <Text>{`Send this link to the grown-up you're inviting. It works once, until ${formatDateTime(link.expiresAt)}. They also need to be allowed to sign in to this site.`}</Text>
            <ClipboardText text={link.link} labels={{ copyAction: "Copy the invitation link" }} tooltip={{ text: "Copy", copiedText: "Link copied" }} />
          </div>
        )}
        {error === undefined ? null : <p role="alert" className="text-kumo-danger">{error}</p>}
      </section>
    </Surface>
  );
};

const PinAndDevices = ({ family, onChanged }: { family: FamilyView; onChanged: () => void }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState<string | undefined>(undefined);
  return (
    <Surface className="flex flex-col gap-4 rounded-xl border border-kumo-hairline p-5">
      <section aria-labelledby="settings-pin" className="flex flex-col gap-4">
        <h2 id="settings-pin" className="text-lg font-semibold">PIN and practice devices</h2>
        {family.pinLocked ? <Text>Your PIN is locked for a few minutes after too many tries. You can still end practice below, or set a new PIN.</Text> : null}
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
          event.preventDefault();
          api.call("family.changePin", { body: { pin } }).then(() => {
            setPin("");
            setMessage("Your new PIN is saved.");
            announce("Your new PIN is saved.");
            onChanged();
          }, (caught: unknown) => setMessage(messageFor(caught)));
        }}>
          <Input label="New family PIN" description="4 to 8 digits." type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(event) => setPin(event.target.value)} />
          <Button type="submit" disabled={!/^\d{4,8}$/.test(pin)}>Change PIN</Button>
        </form>
        <div className="flex flex-col gap-2">
          <Text>Forgot the PIN, or a tablet is stuck in practice? End practice on every device from here.</Text>
          <Button className="self-start" onClick={() => {
            api.call("family.endChildSessions", { body: {} }).then(({ ended }) => {
              const said = ended === 0 ? "No device was in practice." : `Ended practice on ${ended} ${ended === 1 ? "device" : "devices"}.`;
              setMessage(said);
              announce(said);
            }, (caught: unknown) => setMessage(messageFor(caught)));
          }}>End practice on all devices</Button>
        </div>
        {message === undefined ? null : <p role="status">{message}</p>}
      </section>
    </Surface>
  );
};

const ReadAloud = ({ family, onChanged }: { family: FamilyView; onChanged: () => void }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <Surface className="flex flex-col gap-4 rounded-xl border border-kumo-hairline p-5">
      <section aria-labelledby="settings-read-aloud" className="flex flex-col gap-4">
        <h2 id="settings-read-aloud" className="text-lg font-semibold">Reading aloud</h2>
        <Text>Practice reads directions, words and stories aloud with your browser's own voice, which may send those words (never your child's answers) to your browser's speech service. With it off, a grown-up reads them instead: the screen shows them what to say.</Text>
        <Switch label="Read practice aloud" checked={family.readAloud} disabled={saving} onCheckedChange={(on) => {
          setSaving(true);
          setError(undefined);
          api.call("family.readAloud", { body: { on } }).then(() => {
            announce(on ? "Reading aloud is on." : "Reading aloud is off.");
            onChanged();
          }, (caught: unknown) => setError(messageFor(caught))).finally(() => setSaving(false));
        }} />
        {error === undefined ? null : <p role="alert" className="text-kumo-danger">{error}</p>}
      </section>
    </Surface>
  );
};

const YourAccount = ({ family }: { family: FamilyView }) => {
  const api = useApi();
  const refresh = useRefreshSignIn();
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const last = family.adults.length === 1;
  return (
    <Surface className="flex flex-col gap-4 rounded-xl border border-kumo-hairline p-5">
      <section aria-labelledby="settings-account" className="flex flex-col gap-4">
        <h2 id="settings-account" className="text-lg font-semibold">Your account</h2>
        <Text>{last
          ? "Deleting your account also deletes your family and all its practice, because you're its only grown-up. Download everything first if you want to keep it."
          : "Deleting your account takes you out of the family; its other grown-ups keep everything."} Your sign-in is removed from this site. If you sign in again later, you'll start over.</Text>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
          event.preventDefault();
          api.call("family.deleteAccount", { body: { confirm: "delete" } }).then(() => refresh(), (caught: unknown) => setError(messageFor(caught)));
        }}>
          <Input label='To delete your account, type "delete"' value={confirm} onChange={(event) => setConfirm(event.target.value)} />
          <Button type="submit" variant="destructive" disabled={confirm !== "delete"}>Delete my account</Button>
        </form>
        {error === undefined ? null : <p role="alert" className="text-kumo-danger">{error}</p>}
      </section>
    </Surface>
  );
};

const YourData = ({ notice, onDeleted }: { notice: FamilyNoticeView; onDeleted: () => void }) => {
  const api = useApi();
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <Surface className="flex flex-col gap-4 rounded-xl border border-kumo-hairline p-5">
      <section aria-labelledby="settings-data" className="flex flex-col gap-4">
        <h2 id="settings-data" className="text-lg font-semibold">Your family's data</h2>
        <NoticeText notice={notice} headingLevel={3} />
        <Button className="self-start" icon={<DownloadSimpleIcon aria-hidden />} onClick={() => {
          api.call("family.export").then((data) => download("home-learning-export.json", data), (caught: unknown) => setError(messageFor(caught)));
        }}>Download everything</Button>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
          event.preventDefault();
          api.call("family.delete", { body: { confirm: "delete" } }).then(onDeleted, (caught: unknown) => setError(messageFor(caught)));
        }}>
          <Input label='To delete your family and all practice, type "delete"' value={confirm} onChange={(event) => setConfirm(event.target.value)} />
          <Button type="submit" variant="destructive" disabled={confirm !== "delete"}>Delete our family</Button>
        </form>
        {error === undefined ? null : <p role="alert" className="text-kumo-danger">{error}</p>}
      </section>
    </Surface>
  );
};

/** Children, the PIN, practice devices, and the family's data. */
export const HomeSettingsPage = () => {
  const [home, reload] = useFamily();
  if (home.status === "loading") return <LoadingSkeleton label="Loading your family" />;
  if (home.status === "error") return <ErrorState error={home.error} title="We couldn't load your family" onRetry={reload} />;
  const family = home.data.family;
  if (family === null) return <Navigate to={HOME_PATH} replace />;
  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Family settings</PageHeading>
      <HomeLearningNav />
      <Children family={family} onChanged={reload} />
      <GrownUps family={family} onChanged={reload} />
      <PinAndDevices family={family} onChanged={reload} />
      <ReadAloud family={family} onChanged={reload} />
      <YourData notice={home.data.notice} onDeleted={reload} />
      <YourAccount family={family} />
    </div>
  );
};
