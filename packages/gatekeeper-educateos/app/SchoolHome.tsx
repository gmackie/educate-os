import { useEffect, useState } from "react";
import { Button, Empty, Loader, Text } from "@cloudflare/kumo";
import { BookOpenIcon, ChalkboardTeacherIcon, GearSixIcon, UsersThreeIcon } from "@phosphor-icons/react";
import type { DistrictApiClient, RouteResponse } from "@educateos/api-client";

type Me = RouteResponse<"me.get">;

/** A screen this person has, and where it opens. */
interface Destination {
  label: string;
  description: string;
  path: string;
  icon: typeof BookOpenIcon;
}

const destinationsFor = (me: Me): Destination[] => {
  const destinations: Destination[] = [];
  if (me.roles.some((role) => role.role === "district-admin" && role.scope.level === "district")) {
    destinations.push({ label: "Administration", description: "Classes, people, guardians and policies.", path: "/admin", icon: GearSixIcon });
  }
  if (me.kind === "staff") {
    destinations.push({ label: "Teacher Studio", description: "Your classes, assignments and grades.", path: "/teach", icon: ChalkboardTeacherIcon });
  }
  if (me.kind === "student") {
    destinations.push({ label: "Learning Home", description: "Your classes, work and grades.", path: "/learn", icon: BookOpenIcon });
  }
  if (me.kind === "guardian") {
    destinations.push({ label: "Family", description: "What your children's teachers have shared.", path: "/learn/family", icon: UsersThreeIcon });
  }
  return destinations;
};

type Load = { status: "loading" } | { status: "ready"; me: Me } | { status: "error" };

/** Where the School app opens with no place named: the screens this person has. */
export const SchoolHome = ({ client, onOpen }: { client: DistrictApiClient; onOpen: (path: string) => void }) => {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  useEffect(() => {
    let current = true;
    client.call("me.get").then(
      (me) => current && setLoad({ status: "ready", me }),
      () => current && setLoad({ status: "error" }),
    );
    return () => {
      current = false;
    };
  }, [client]);

  if (load.status === "loading") {
    return (
      <div role="status" className="flex justify-center p-12">
        <Loader size="lg" />
        <span className="sr-only">Opening your school</span>
      </div>
    );
  }
  if (load.status === "error") {
    return <Empty title="We couldn't reach your school" description="Try again in a moment, or reconnect your school account." />;
  }
  const destinations = destinationsFor(load.me);
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <Text variant="heading" size="lg" as="h1">{`Hi, ${load.me.displayName}`}</Text>
      {destinations.length === 0 ? (
        <Empty title="Nothing here yet" description="Your district hasn't given you a class or a role." />
      ) : (
        <ul className="flex flex-col gap-3">
          {destinations.map(({ label, description, path, icon: Icon }) => (
            <li key={path}>
              <Button variant="secondary" className="h-auto w-full justify-start gap-3 py-3 text-left" icon={<Icon aria-hidden size={22} />} onClick={() => onOpen(path)}>
                <span className="flex flex-col">
                  <Text variant="heading">{label}</Text>
                  <Text variant="secondary">{description}</Text>
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
};
