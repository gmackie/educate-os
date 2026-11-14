import type { ReactNode } from "react";
import { Table, Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";
import { LoadState } from "../app/LoadState.tsx";
import { useLoad } from "../app/useLoad.ts";
import { TableScroll } from "../app/TableScroll.tsx";

type Settings = RouteResponse<"admin.signInSettings">;

const PROVIDERS: Readonly<Record<NonNullable<Settings["provider"]>, string>> = {
  "district-sso": "Your district's single sign-on",
  "cloudflare-access": "Cloudflare Access",
};

const count = (n: number) => n.toLocaleString("en-US");

/** A term and what the district knows about it. */
const Fact = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
    <dt className="font-semibold sm:w-56 sm:shrink-0">{term}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </div>
);

const deploymentFacts = (deployment: Settings["deployment"]) => {
  if (deployment === undefined) {
    return <Fact term="Verified by">This deployment did not say how it verifies sign-ins.</Fact>;
  }
  if (deployment.verifier === "demo") {
    return <Fact term="Verified by">Synthetic sign-ins: this is a demo district, and nobody signs in with a real account.</Fact>;
  }
  return (
    <>
      <Fact term="Verified by">Cloudflare Access: every request carries a signed Access assertion, checked against the team's keys, issuer, audience and expiry.</Fact>
      <Fact term="Access team"><span className="font-mono">{deployment.teamDomain}</span></Fact>
      <Fact term="Access applications accepted">{count(deployment.applications)}</Fact>
      {deployment.cleverDistrictId !== undefined && <Fact term="Clever Instant Login district"><span className="font-mono">{deployment.cleverDistrictId}</span></Fact>}
    </>
  );
};

/**
 * Sign-in (SCHO-376): how the district signs people in, read-only. What the district itself knows:
 * the configured provider, the issuers it trusts and how many people each signs in, and how the
 * deployment verifies requests. Never a secret: client secrets, Access audience tags and tokens
 * stay with the deployment.
 */
export const SignInPage = () => {
  const settings = useLoad("sign-in", (client) => client.call("admin.signInSettings"));
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Text as="h2" variant="heading" size="lg">Sign-in</Text>
        <Text variant="secondary">
          How people sign in to this district, as the district knows it. Read-only: sign-in is set in the district's configuration and its Cloudflare Access application.
          Multi-factor authentication, session length and which accounts may sign in at all are set in your identity provider and Access, not here.
        </Text>
      </div>
      <LoadState loaded={settings} what="the sign-in settings" onRetry={settings.reload}>
        {(data) => (
          <>
            <section aria-labelledby="sign-in-provider" className="flex flex-col gap-3">
              <Text as="h3" variant="heading" id="sign-in-provider">Provider</Text>
              <dl className="flex flex-col gap-2">
                <Fact term="Configured provider">{data.provider === undefined ? "Not set: no configuration has been applied yet." : PROVIDERS[data.provider]}</Fact>
                {data.classlink !== undefined && (
                  <>
                    <Fact term="ClassLink tenant"><span className="font-mono">{data.classlink.tenantId}</span></Fact>
                    <Fact term="ClassLink issuer"><span className="font-mono">{data.classlink.issuer}</span></Fact>
                    <Fact term="ClassLink client ID"><span className="font-mono">{data.classlink.clientId}</span></Fact>
                    <Fact term="Signs people in by">{data.classlink.subjectClaim === "sub" ? "ClassLink user ID (sub)" : "Username (preferred_username)"}</Fact>
                  </>
                )}
                {deploymentFacts(data.deployment)}
              </dl>
            </section>
            <section aria-labelledby="sign-in-issuers" className="flex flex-col gap-3">
              <Text as="h3" variant="heading" id="sign-in-issuers">Trusted issuers</Text>
              <Text variant="secondary">
                A sign-in is accepted only from these issuers, and only for someone the district has linked to that issuer's account. The district alone decides who a sign-in is.
              </Text>
              <TableScroll label="Trusted issuers">
                <Table>
                  <caption className="sr-only">Trusted issuers</caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Issuer</Table.Head>
                      <Table.Head>Active people</Table.Head>
                      <Table.Head>Inactive people</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {data.issuers.map((issuer) => (
                      <Table.Row key={issuer.issuer}>
                        <Table.Cell><span className="font-mono">{issuer.issuer}</span></Table.Cell>
                        <Table.Cell>{count(issuer.activePeople)}</Table.Cell>
                        <Table.Cell>{count(issuer.inactivePeople)}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </TableScroll>
              <dl className="flex flex-col gap-2">
                <Fact term="Active people who cannot sign in">{count(data.activeWithoutSignIn)}</Fact>
                <Fact term="Sign-ins waiting to be linked">{count(data.pendingLinks)}</Fact>
              </dl>
            </section>
          </>
        )}
      </LoadState>
    </div>
  );
};
