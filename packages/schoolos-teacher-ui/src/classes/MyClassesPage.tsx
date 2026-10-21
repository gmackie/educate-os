import { Badge, Empty, LayerCard, Text } from "@cloudflare/kumo";
import { Student, UsersThree } from "@phosphor-icons/react";
import { Loading } from "../Loading.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import { routeHref } from "../route.ts";
import { useLoad } from "../useLoad.ts";
import { classLabel } from "./classLabel.ts";

/** The teacher's classes, each with how many students are enrolled. */
export const MyClassesPage = () => {
  const classes = useLoad("classes", async (client) => {
    const offerings = await client.call("teacher.listOfferings");
    return Promise.all(offerings.map(async (teaching) => {
      const roster = await client.call("teacher.roster", { params: { offeringId: teaching.offering.id } });
      const students = roster.filter((entry) => entry.enrollment.role === "student" && entry.enrollment.status === "active").length;
      return { teaching, students };
    }));
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeading>My classes</PageHeading>
      {classes.status === "loading" && <Loading label="Loading your classes…" />}
      {classes.status === "error" && <Problem error={classes.error} onRetry={classes.reload} />}
      {classes.status === "ready" && classes.data.length === 0 && (
        <Empty icon={<UsersThree size={32} aria-hidden />} title="No classes yet" description="When your district adds you to a class, it appears here." />
      )}
      {classes.status === "ready" && classes.data.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {classes.data.map(({ teaching, students }) => (
            <li key={teaching.offering.id}>
              <LayerCard className="p-4">
                <a href={routeHref({ screen: "roster", offeringId: teaching.offering.id })} className="flex flex-col gap-2 rounded text-kumo-default no-underline focus-visible:ring-2 focus-visible:ring-kumo-brand">
                  <Text variant="heading" as="span">{classLabel(teaching)}</Text>
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant="neutral" icon={<Student aria-hidden />}>{students === 1 ? "1 student" : `${students} students`}</Badge>
                    {teaching.role === "co-teacher" && <Badge variant="secondary">Co-teacher</Badge>}
                  </span>
                </a>
              </LayerCard>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
