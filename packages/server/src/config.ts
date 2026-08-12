import { randomBytes } from 'node:crypto';
import path from 'node:path';

export interface Config {
  dataDir: string;
  port: number;
  /** Base URL used when composing magic-link URLs. */
  publicUrl: string;
  adminKey: string;
  adminKeyGenerated: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.GREENROOM_PORT ?? 4788);
  const dataDir = path.resolve(env.GREENROOM_DATA_DIR ?? '.greenroom-data');
  const publicUrl = (env.GREENROOM_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');

  let adminKey = env.GREENROOM_ADMIN_KEY ?? '';
  let adminKeyGenerated = false;
  if (!adminKey) {
    adminKey = randomBytes(24).toString('base64url');
    adminKeyGenerated = true;
  }

  return { dataDir, port, publicUrl, adminKey, adminKeyGenerated };
}
