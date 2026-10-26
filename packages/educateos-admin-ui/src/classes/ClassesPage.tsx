import { useState } from "react";
import { Empty, Input, Link, Table, Text } from "@cloudflare/kumo";
import { ChalkboardTeacher } from "@phosphor-icons/react";
import type { RouteResponse } from "@educateos/api-client";
import { count, type DirectoryNames } from "../app/labels.ts";
import { LoadState } from "../app/LoadState.tsx";
import { useDirectoryNames } from "../app/useDirectoryNames.ts";
import { useLoad } from "../app/useLoad.ts";

type DistrictClass = RouteResponse<"admin.listOfferings">[number];

const title = (c: DistrictClass) => `${c.course.title} · ${c.offering.sectionName}`;

const ClassTable = ({ classes, names }: { classes: readonly DistrictClass[]; names: DirectoryNames }) => {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle === ""
    ? classes
    : classes.filter((c) => [title(c), names.school(c.offering.schoolId), names.term(c.offering.termId), ...c.teachers].some((text) => text.toLowerCase().includes(needle)));

  return (
    <div className="flex flex-col gap-3">
      <div className="max-w-sm">
        <Input label="Find a class" description="By course, section, school, term or teacher." value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <Text variant="secondary" size="sm">
        {needle === "" ? count(classes.length, "class", "classes") : `${count(shown.length, "class", "classes")} of ${classes.length.toLocaleString("en-US")} match`}
      </Text>
      {shown.length === 0 ? <Text variant="secondary">No class matches “{query.trim()}”.</Text> : (
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">Every class in the district</caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Class</Table.Head>
                <Table.Head>School</Table.Head>
                <Table.Head>Term</Table.Head>
                <Table.Head>Teachers</Table.Head>
                <Table.Head>Students</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {shown.map((c) => (
                <Table.Row key={c.offering.id}>
                  <Table.Cell>{title(c)}</Table.Cell>
                  <Table.Cell>{names.school(c.offering.schoolId)}</Table.Cell>
                  <Table.Cell>{names.term(c.offering.termId)}</Table.Cell>
                  <Table.Cell>{c.teachers.length === 0 ? <Text variant="secondary" as="span">No teacher yet</Text> : c.teachers.join(", ")}</Table.Cell>
                  <Table.Cell>{c.students}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
    </div>
  );
};

/**
 * Every class in the district, from the roster or made by hand: its course and section, school,
 * term, teachers and how many students are actively enrolled. Students are counted, never named.
 */
export const ClassesPage = () => {
  const names = useDirectoryNames();
  const classes = useLoad("classes", async (client) => {
    const listed = await client.call("admin.listOfferings");
    return listed.toSorted((a, b) => title(a).localeCompare(title(b)));
  });
  return (
    <div className="flex flex-col gap-6">
      <Text as="h2" variant="heading" size="lg">All classes</Text>
      <LoadState loaded={classes} what="the district's classes" onRetry={classes.reload}>
        {(data) => data.length === 0
          ? (
            <Empty
              icon={<ChalkboardTeacher size={32} aria-hidden />}
              title="No classes yet"
              description="Classes appear here once a roster import adds them, or once you add a section by hand."
              contents={<Link href="#/classes-people">Manage classes and people</Link>}
            />
          )
          : <ClassTable classes={data} names={names} />}
      </LoadState>
    </div>
  );
};
