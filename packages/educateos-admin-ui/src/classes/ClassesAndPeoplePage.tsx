import { Banner, Text } from "@cloudflare/kumo";
import { Info } from "@phosphor-icons/react";
import { LoadState } from "../app/LoadState.tsx";
import { useLoad } from "../app/useLoad.ts";
import { DIRECTORY_KIND_NAMES, type DirectoryKind } from "./authoring.ts";
import { CoursesSection } from "./CoursesSection.tsx";
import { PeopleSection } from "./PeopleSection.tsx";
import { SectionsSection } from "./SectionsSection.tsx";
import { TermsSection } from "./TermsSection.tsx";

/**
 * Classes and people, built by hand: terms, courses, sections, people and who is in each section.
 * For a district with no roster, such as a homeschool co-op. Where a roster owns a record type, its
 * records are listed here but changed in the roster.
 */
export const ClassesAndPeoplePage = () => {
  const directory = useLoad("authoring", (client) => client.call("admin.authoring"));
  return (
    <div className="flex flex-col gap-8">
      <Text as="h2" variant="heading" size="lg">Manage classes and people</Text>
      <LoadState loaded={directory} what="classes and people" onRetry={directory.reload}>
        {(data) => {
          const external = (Object.entries(data.authority) as [DirectoryKind, string][]).filter(([, owner]) => owner !== "local");
          return (
            <>
              {external.length > 0 && (
                <Banner
                  icon={<Info weight="fill" />}
                  title="Some records come from your roster"
                  description={`${external.map(([kind, owner]) => `${DIRECTORY_KIND_NAMES[kind]} (${owner.replace(/^external:/, "")})`).join(", ")} are changed in their source system and synced here.`}
                />
              )}
              <TermsSection directory={data} onChanged={directory.reload} />
              <CoursesSection directory={data} onChanged={directory.reload} />
              <SectionsSection directory={data} onChanged={directory.reload} />
              <PeopleSection directory={data} onChanged={directory.reload} />
            </>
          );
        }}
      </LoadState>
    </div>
  );
};
