import { Text } from "@cloudflare/kumo";
import type { Me } from "../../shared/api.ts";

/** This admin's edition and the signed-in operator. Changed through the Worker's configuration. */
export const SettingsPage = ({ me }: { me: Me }) => (
  <div className="flex flex-col gap-4">
    <Text as="h2" variant="heading" size="lg">Settings</Text>
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
      <dt className="text-kumo-subtle">Edition</dt>
      <dd>{me.edition === "hosted" ? "Hosted (admin.educateos.io)" : "Open source, in your own Cloudflare account"}</dd>
      {me.allowedOrigins !== undefined && (
        <>
          <dt className="text-kumo-subtle">Workspaces allowed</dt>
          <dd>{me.allowedOrigins.length === 0 ? "None configured" : me.allowedOrigins.join(", ")}</dd>
        </>
      )}
      <dt className="text-kumo-subtle">Signed in as</dt>
      <dd>{me.operator.email} ({me.operator.role === "admin" ? "can make changes" : "read only"})</dd>
    </dl>
    <Text variant="secondary" size="sm">
      Operators are listed in the Worker's ADMINS variable; the edition and allowed origins in EDITION and OSS_WORKSPACE_ORIGINS.
      This admin stores no student records: people and devices are read live from each district.
    </Text>
  </div>
);
