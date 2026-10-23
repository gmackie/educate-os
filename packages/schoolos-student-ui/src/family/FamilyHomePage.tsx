import { Empty } from "@cloudflare/kumo";
import { UsersThreeIcon } from "@phosphor-icons/react";
import { Navigate } from "@tanstack/react-router";
import { useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { childPath } from "../router.tsx";

/** A guardian's home: their first child's classes, or a note that no child is connected yet. */
export const FamilyHomePage = () => {
  const [children, reload] = useQuery("children", (api) => api.call("guardian.listChildren"));
  if (children.status === "loading") return <LoadingSkeleton label="Loading your children" />;
  if (children.status === "error") return <ErrorState error={children.error} title="We couldn't load your children" onRetry={reload} />;
  const [first] = children.data;
  if (first === undefined) {
    return (
      <Empty
        icon={<UsersThreeIcon aria-hidden size={32} />}
        title="No children connected yet"
        description="When your school confirms you as a guardian, your child's classes show up here."
      />
    );
  }
  return <Navigate to={childPath(first.studentPrincipalId)} replace />;
};
