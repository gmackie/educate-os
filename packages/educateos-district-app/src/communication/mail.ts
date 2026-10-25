// Communication (SCHO-189): how the district sends email. The district sends through a provider in
// its own account (ADR-0011: EducateOS hosts no service), by default the Cloudflare Email Service
// binding of its own Worker (`@educateos/district-worker`). Any other provider (SMTP relay, a
// transactional API) plugs in by implementing `MailSender`.

/** One email. Plain text always; HTML optionally, already escaped by whoever rendered it. */
export interface MailMessage {
  /** One recipient address. */
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Extra headers, such as `List-Unsubscribe`. */
  headers?: Record<string, string>;
}

/** Sends email. It throws if the provider refused the message; a resolved send was accepted. */
export interface MailSender {
  send(message: MailMessage): Promise<{ messageId?: string }>;
}

/** A {@link MailSender} that keeps what it was given, for tests and the local harness. */
export class InMemoryMailSender implements MailSender {
  readonly sent: MailMessage[] = [];
  /** Set to make every send fail, as a provider outage would. */
  failing = false;

  async send(message: MailMessage): Promise<{ messageId: string }> {
    if (this.failing) throw new Error("the mail provider refused the message");
    this.sent.push(structuredClone(message));
    return { messageId: `mem-${this.sent.length}` };
  }
}

/** Whether `value` is one plain email address with no header-injection characters. */
export function isDeliverableAddress(value: string): boolean {
  return /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/.test(value) && value.length <= 254;
}
