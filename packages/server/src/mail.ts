import nodemailer from 'nodemailer';
import type { Config } from './config.js';

/**
 * Sending a review link.
 *
 * SMTP rather than any particular vendor's API. Greenroom is meant to be self-hosted by
 * people who are not us, and every provider worth using — Resend, SES, Postmark, a
 * company's own relay — speaks SMTP. Picking one vendor's HTTP API would save a
 * dependency and hand every adopter an account they did not want.
 *
 * Unconfigured is a supported state, not an error. Without SMTP the sidecar runs exactly
 * as it did before: an admin mints links and delivers them by hand. What must not happen
 * is the reviewer being shown a "send me a link" form that silently does nothing, so the
 * capability is advertised (`/api/health`) and the gate only offers the form when it is
 * really there.
 */
export interface Mailer {
  readonly enabled: boolean;
  sendReviewLink(to: string, url: string): Promise<void>;
}

const TEXT = (url: string) =>
  `Here is your Greenroom review link.

${url}

It signs you in — treat it like a password, and do not forward it. If you need
another later, ask for one from the same page you were on.`;

const HTML = (url: string) =>
  `<p>Here is your Greenroom review link.</p>
<p><a href="${url}">Open the review</a></p>
<p style="color:#666;font-size:13px">It signs you in — treat it like a password, and do
not forward it. If you need another later, ask for one from the same page you were on.</p>`;

export function createMailer(config: Config): Mailer {
  if (!config.smtpUrl || !config.mailFrom) {
    return {
      enabled: false,
      async sendReviewLink() {
        throw new Error('No SMTP configured — set GREENROOM_SMTP_URL and GREENROOM_MAIL_FROM.');
      },
    };
  }
  const transport = nodemailer.createTransport(config.smtpUrl);
  return {
    enabled: true,
    async sendReviewLink(to: string, url: string) {
      await transport.sendMail({
        from: config.mailFrom,
        to,
        subject: 'Your Greenroom review link',
        text: TEXT(url),
        html: HTML(url),
      });
    },
  };
}

/** Collects mail instead of sending it. Tests assert on what a reviewer would receive
 *  without a network, and without a stub so permissive it would pass on a broken sender. */
export function memoryMailer(): Mailer & { sent: { to: string; url: string }[] } {
  const sent: { to: string; url: string }[] = [];
  return {
    enabled: true,
    sent,
    async sendReviewLink(to: string, url: string) {
      sent.push({ to, url });
    },
  };
}
