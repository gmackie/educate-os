import { SkeletonLine } from "@cloudflare/kumo";

/** Placeholder lines while a screen or section loads, announced once as "Loading…". */
export const LoadingSkeleton = ({ label = "Loading", lines = 3 }: { label?: string; lines?: number }) => (
  <div role="status" aria-label={label} className="flex flex-col gap-3 py-2">
    {Array.from({ length: lines }, (_, i) => (
      <SkeletonLine key={i} minWidth={40} maxWidth={95} />
    ))}
  </div>
);
