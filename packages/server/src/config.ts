import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  dataDir: string;
  port: number;
  /** Base URL used when composing magic-link URLs. */
  publicUrl: string;
  adminKey: string;
  adminKeyGenerated: boolean;
  /** Directory holding the reviewer shell's static files. */
  shellDir: string;
  /**
   * Shared secret a CDN attaches to every origin request, proving the request came
   * through the edge rather than straight at the origin. Empty disables the check —
   * which is what local development wants, and what `cli.ts` refuses to allow in
   * production.
   */
  edgeSecret: string;
  /**
   * SMTP connection string, e.g. `smtps://user:pass@smtp.resend.com:465`. Empty leaves
   * self-service link requests switched off and the sidecar behaving exactly as before:
   * an admin mints links and delivers them by hand.
   */
  smtpUrl: string;
  /** From address for review-link mail. Required alongside `smtpUrl`; without it the
   *  mailer stays off, because a message with no sender is a bounce, not a delivery. */
  mailFrom: string;
  /**
   * How long a self-service link lasts. Short on purpose — the reviewer can always ask
   * for another, which is the point of the feature, so there is no reason for one to sit
   * in an inbox for months being forwardable.
   */
  selfServiceLinkTtlHours: number;
}

/** Works from both src/ (tests via vitest) and dist/ (built CLI) — the shell
 * directory sits at the package root either way. */
export const defaultShellDir = () =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../shell');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.GREENROOM_PORT ?? 4788);
  const dataDir = path.resolve(env.GREENROOM_DATA_DIR ?? '.greenroom-data');
  const publicUrl = (env.GREENROOM_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
  const shellDir = env.GREENROOM_SHELL_DIR ? path.resolve(env.GREENROOM_SHELL_DIR) : defaultShellDir();

  let adminKey = env.GREENROOM_ADMIN_KEY ?? '';
  let adminKeyGenerated = false;
  if (!adminKey) {
    adminKey = randomBytes(24).toString('base64url');
    adminKeyGenerated = true;
  }

  const edgeSecret = env.GREENROOM_EDGE_SECRET ?? '';
  const smtpUrl = env.GREENROOM_SMTP_URL ?? '';
  const mailFrom = env.GREENROOM_MAIL_FROM ?? '';
  const selfServiceLinkTtlHours = Number(env.GREENROOM_LINK_TTL_HOURS ?? 72);

  return {
    dataDir,
    port,
    publicUrl,
    adminKey,
    adminKeyGenerated,
    shellDir,
    edgeSecret,
    smtpUrl,
    mailFrom,
    selfServiceLinkTtlHours,
  };
}
