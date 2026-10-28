// Your devices (SCHO-260, plan §4): the phones signed in as this person, each of which can be
// signed out, and "Sign out everywhere". Every role has it; the district answers with the caller's
// own devices only (SCHO-261). There is no rename route yet, so a device keeps the name it paired with.
import { useState } from "react";
import { Badge, Banner, Button, Dialog, Empty, LinkButton, Table, Text } from "@cloudflare/kumo";
import { DeviceMobileIcon, SignOutIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { DeviceView } from "@educateos/api-client";
import { messageFor, useApi, useQuery } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { formatDateTime } from "../labels.ts";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { CONNECT_PHONE_PATH } from "./paths.ts";

const PLATFORM_LABELS: Record<DeviceView["platform"], string> = { ios: "iPhone or iPad", android: "Android", web: "Web", other: "Other" };

/** The device's kind and model, such as "iPhone or iPad · iPhone17,3". */
const phoneOf = (device: DeviceView) => [PLATFORM_LABELS[device.platform], device.model].filter((part) => part !== "").join(" · ");

const Failure = ({ message }: { message: string }) => (
  <div role="alert">
    <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title="That didn't work" description={message} />
  </div>
);

const When = ({ iso }: { iso: string }) => <time dateTime={iso}>{formatDateTime(iso)}</time>;

/** Your devices. */
export const DevicesPage = () => {
  const api = useApi();
  const announce = useAnnounce();
  const [devices, reload] = useQuery("devices", (client) => client.call("me.devices"));
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);

  const act = async (key: string, run: () => Promise<string>) => {
    setBusy(key);
    setFailure(undefined);
    try {
      announce(await run());
      reload();
    } catch (error) {
      setFailure(messageFor(error));
    } finally {
      setBusy(undefined);
    }
  };

  const signOut = (device: DeviceView) =>
    act(device.id, async () => {
      await api.call("me.revokeDevice", { params: { deviceId: device.id } });
      return `${device.label} is signed out`;
    });

  const signOutEverywhere = () =>
    act("everywhere", async () => {
      const { revoked } = await api.call("me.revokeAllDevices");
      setConfirming(false);
      return revoked === 1 ? "1 device is signed out" : `${revoked} devices are signed out`;
    });

  const heading = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Text variant="heading" size="lg" as="h1">Your devices</Text>
      <LinkButton href={CONNECT_PHONE_PATH} variant="primary" icon={<DeviceMobileIcon aria-hidden />}>Connect a phone</LinkButton>
    </div>
  );

  if (devices.status === "loading") return <div className="flex flex-col gap-6">{heading}<LoadingSkeleton label="Loading your devices" /></div>;
  if (devices.status === "error") return <div className="flex flex-col gap-6">{heading}<ErrorState error={devices.error} title="We couldn't load your devices" onRetry={reload} /></div>;

  const list = devices.data.devices;
  const active = list.filter((device) => device.status === "active");
  return (
    <div className="flex flex-col gap-6">
      {heading}
      <Text variant="secondary">Phones you connected to your school account. Sign out a phone you no longer use, or one you've lost.</Text>
      {failure === undefined || confirming ? null : <Failure message={failure} />}
      {list.length === 0 ? (
        <Empty title="No phones yet" description="Connect a phone to get your classes, calendar and messages on it." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-kumo-hairline">
          <Table>
            <caption className="sr-only">Your devices</caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Device</Table.Head>
                <Table.Head>Phone</Table.Head>
                <Table.Head>App version</Table.Head>
                <Table.Head>Added</Table.Head>
                <Table.Head>Last seen</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head><span className="sr-only">Actions</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {list.map((device) => (
                <Table.Row key={device.id}>
                  <Table.Cell>{device.label}</Table.Cell>
                  <Table.Cell>{phoneOf(device)}</Table.Cell>
                  <Table.Cell>{device.appVersion}</Table.Cell>
                  <Table.Cell><When iso={device.createdAt} /></Table.Cell>
                  <Table.Cell><When iso={device.lastSeenAt} /></Table.Cell>
                  <Table.Cell>
                    {device.status === "active" ? <Badge variant="success">Signed in</Badge> : <Badge variant="neutral">Signed out</Badge>}
                  </Table.Cell>
                  <Table.Cell>
                    {device.status === "active" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busy === device.id}
                        disabled={busy !== undefined}
                        onClick={() => void signOut(device)}
                        aria-label={`Sign out ${device.label}`}
                      >
                        Sign out
                      </Button>
                    ) : null}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
      {active.length === 0 ? null : (
        <div>
          <Button variant="secondary-destructive" icon={<SignOutIcon aria-hidden />} disabled={busy !== undefined} onClick={() => setConfirming(true)}>
            Sign out everywhere
          </Button>
        </div>
      )}
      <Dialog.Root role="alertdialog" open={confirming} onOpenChange={(open) => {
        if (!open && busy === undefined) {
          setConfirming(false);
          setFailure(undefined);
        }
      }}>
        <Dialog className="flex flex-col gap-4 p-6" size="lg">
          <Dialog.Title className="text-xl font-semibold">Sign out everywhere?</Dialog.Title>
          <Dialog.Description className="text-kumo-subtle">
            {`Every phone connected to your account is signed out (${active.length === 1 ? "1 phone" : `${active.length} phones`}). To use one again, connect it again.`}
          </Dialog.Description>
          {failure === undefined ? null : <Failure message={failure} />}
          <div className="flex justify-end gap-2">
            <Button disabled={busy !== undefined} onClick={() => { setConfirming(false); setFailure(undefined); }}>Cancel</Button>
            <Button variant="destructive" loading={busy === "everywhere"} onClick={() => void signOutEverywhere()}>
              Yes, sign out everywhere
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
};
