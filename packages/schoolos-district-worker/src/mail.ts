// The district's email (SCHO-189): the district app's `MailSender` over the Worker's Cloudflare
// Email Service binding (`send_email`, declared in cloudflare.config.ts as `SEND_EMAIL`). Mail goes
// out from the district's own Cloudflare account and its own onboarded domain; SchoolOS hosts no
// sender (ADR-0011). Like district.ts this module imports nothing Workers-only: the binding is
// named by the part of it the sender calls.
import type { MailMessage, MailSender } from "@schoolos/district-app";

/** The part of a `send_email` binding (`SendEmail` in Workers' typings) the sender calls. */
export interface SendEmailBinding {
  send(message: {
    from: string | { name: string; email: string };
    to: string;
    subject: string;
    text?: string;
    html?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

/** Where the district's email comes from. */
export interface MailIdentity {
  /** The sender address, on a domain onboarded to Email Service. */
  from: string;
  /** The sender's display name. */
  fromName?: string | undefined;
}

/** A {@link MailSender} that sends through a Cloudflare Email Service binding, as `identity`. */
export function cloudflareEmailSender(binding: SendEmailBinding, identity: MailIdentity): MailSender {
  const from = identity.fromName === undefined ? identity.from : { name: identity.fromName, email: identity.from };
  return {
    async send(message: MailMessage) {
      const { messageId } = await binding.send({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
        ...(message.headers === undefined ? {} : { headers: message.headers }),
      });
      return { messageId };
    },
  };
}
