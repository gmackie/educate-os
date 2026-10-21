import { Loader } from "@cloudflare/kumo";

/** A loading placeholder that says what it is waiting for. */
export const Loading = ({ label }: { label: string }) => (
  <div role="status" className="flex items-center gap-2 py-6">
    <Loader size="sm" />
    <span>{label}</span>
  </div>
);
