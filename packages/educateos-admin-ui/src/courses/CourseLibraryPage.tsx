import { useId, useState } from "react";
import { Badge, Banner, Button, Table, Text } from "@cloudflare/kumo";
import { CheckCircle, Warning } from "@phosphor-icons/react";
import type { RouteResponse } from "@educateos/api-client";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { LoadState } from "../app/LoadState.tsx";
import { errorMessage, useLoad } from "../app/useLoad.ts";

type LibraryCourse = RouteResponse<"admin.listLibraryCourses">[number];

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (at: string) => new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/**
 * Course library (SCHO-331): the courses the district has imported for its teachers, each a signed
 * course bundle from a publisher the deployment trusts. Importing only adds the course to the
 * library; teachers choose whether to add it to their classes, where it arrives as draft modules.
 */
export const CourseLibraryPage = () => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const inputId = useId();
  const courses = useLoad("course-library", (c) => c.call("admin.listLibraryCourses"));
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string>();
  const [imported, setImported] = useState<LibraryCourse>();

  const importBundle = async () => {
    if (file === null) return;
    setImporting(true);
    setError(undefined);
    setImported(undefined);
    try {
      let bundle: unknown;
      try {
        bundle = JSON.parse(await file.text());
      } catch {
        throw new Error(`${file.name} is not a course bundle: course bundles are JSON files.`);
      }
      const course = await client.call("admin.importCourseBundle", { body: bundle as never });
      setImported(course);
      setFile(null);
      courses.reload();
      announce(`${course.title} ${course.version} is in the course library. Teachers can now add it to their classes.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <Text as="h2" variant="heading" size="lg">Course library</Text>
        <Text variant="secondary">
          Courses your teachers can add to their classes. Each one is a signed course bundle from a publisher this district trusts, such as
          educateos.io. Adding a course to a class only adds draft modules: nothing a teacher already has changes, and students see nothing until
          the teacher publishes it.
        </Text>
      </div>

      <section aria-labelledby="import-course-heading" className="flex flex-col gap-3">
        <Text as="h3" variant="heading" id="import-course-heading">Import a course bundle</Text>
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className="font-medium">Course bundle (.json)</label>
          <Text variant="secondary" size="sm">
            Every part of the bundle is checked against its publisher's signature before anything is stored. Importing a version again changes nothing.
          </Text>
          <input
            id={inputId}
            key={imported?.digest ?? "none"}
            type="file"
            accept=".json,application/json"
            className="max-w-full rounded-md border border-kumo-line bg-kumo-control p-2 focus-visible:outline-2 focus-visible:outline-kumo-focus"
            onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(undefined); }}
          />
        </div>
        <div>
          <Button variant="primary" onClick={() => void importBundle()} loading={importing} disabled={file === null}>Import course</Button>
        </div>
        {error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="The course was not imported" description={error} />}
        {imported !== undefined && (
          <Banner
            icon={<CheckCircle weight="fill" />}
            title={`${imported.title} ${imported.version} is in the course library`}
            description={`${count(imported.units.length, "unit")} and ${count(imported.activities, "activity", "activities")}, signed by ${imported.publisher.domain}.`}
          />
        )}
      </section>

      <section aria-labelledby="library-heading" className="flex flex-col gap-3">
        <Text as="h3" variant="heading" id="library-heading">Courses in the library</Text>
        <LoadState loaded={courses} what="the course library" onRetry={courses.reload}>
          {(list) => list.length === 0
            ? <Text variant="secondary">No courses yet. Import a course bundle to offer it to your teachers.</Text>
            : (
              <div className="overflow-x-auto">
                <Table>
                  <caption className="sr-only">Courses in the district's course library</caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Course</Table.Head>
                      <Table.Head>Version</Table.Head>
                      <Table.Head>Publisher</Table.Head>
                      <Table.Head>Contents</Table.Head>
                      <Table.Head>Imported</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {list.map((course) => (
                      <Table.Row key={`${course.packageId}@${course.version}`}>
                        <Table.Cell>
                          <div className="flex flex-col">
                            <Text>{course.title}</Text>
                            <Text variant="secondary" size="sm">{[course.gradeBand === undefined ? undefined : `Grade ${course.gradeBand}`, course.packageId].filter((part) => part !== undefined).join(" · ")}</Text>
                          </div>
                        </Table.Cell>
                        <Table.Cell>{course.version}</Table.Cell>
                        <Table.Cell>
                          <div className="flex flex-wrap items-center gap-2">
                            <span>{course.publisher.domain}</span>
                            <Badge variant={course.publisher.signed ? "success" : "neutral"}>{course.publisher.signed ? "Signed" : "This district's own"}</Badge>
                          </div>
                        </Table.Cell>
                        <Table.Cell>{`${count(course.units.length, "unit")}, ${count(course.activities, "activity", "activities")}`}</Table.Cell>
                        <Table.Cell>{day(course.imported.at)}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
            )}
        </LoadState>
      </section>
    </div>
  );
};
