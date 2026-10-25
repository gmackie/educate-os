import { useState } from "react";
import { Button, Input, Text } from "@cloudflare/kumo";
import { LoadState } from "../app/LoadState.tsx";
import { useLoad } from "../app/useLoad.ts";
import { StudentGuardians } from "./StudentGuardians.tsx";

/** How many matching students the finder lists at once. */
const SHOWN = 20;

/**
 * Guardians (ADR-0012): find a student, then invite their guardians, approve the guardians'
 * sign-ins, and confirm, suspend or end each relationship. Only a district administrator reaches
 * this; the district refuses anyone else.
 */
export const GuardiansPage = () => {
  const students = useLoad("guardian-students", (client) => client.call("admin.guardianStudents"));
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Text as="h2" variant="heading" size="lg">Guardians</Text>
        <Text variant="secondary">
          A guardian reads one student's classes, assignments, released feedback and grades, and nothing else. Each guardian needs your
          invitation, your approval of their sign-in, and your confirmation.
        </Text>
      </div>
      <LoadState loaded={students} what="the students" onRetry={students.reload}>
        {(all) => {
          const needle = query.trim().toLocaleLowerCase();
          const matches = needle === "" ? [] : all.filter((s) => s.displayName.toLocaleLowerCase().includes(needle));
          return (
            <section aria-labelledby="find-student" className="flex max-w-xl flex-col gap-3">
              <Text as="h3" variant="heading" id="find-student">Find a student</Text>
              <Input
                label="Student's name"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                description={needle === "" ? `${all.length.toLocaleString("en-US")} students in the district.` : undefined}
              />
              {needle !== "" && (
                <div className="flex flex-col gap-2">
                  <p role="status" className="text-sm text-kumo-subtle">
                    {matches.length === 0 ? "No student matches that name." : `${matches.length.toLocaleString("en-US")} ${matches.length === 1 ? "student matches" : "students match"}.`}
                  </p>
                  {matches.length === 0 ? null : (
                    <ul aria-label="Matching students" className="flex flex-col gap-1">
                      {matches.slice(0, SHOWN).map((student) => (
                        <li key={student.principalId}>
                          <Button
                            variant={selected === student.principalId ? "primary" : "secondary"}
                            aria-pressed={selected === student.principalId}
                            onClick={() => setSelected(student.principalId)}
                          >
                            {student.displayName}{student.status === "active" ? "" : ` (${student.status})`}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {matches.length > SHOWN && <Text variant="secondary" size="sm">Showing {SHOWN} of {matches.length}. Type more of the name to narrow it.</Text>}
                </div>
              )}
            </section>
          );
        }}
      </LoadState>
      {selected !== undefined && <StudentGuardians key={selected} studentId={selected} />}
    </div>
  );
};
