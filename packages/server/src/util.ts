import { createHash, randomUUID, randomBytes } from 'node:crypto';

export const id = () => randomUUID();

export const nowIso = () => new Date().toISOString();

export const sha256Hex = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

export const secret = (bytes = 24) => randomBytes(bytes).toString('base64url');

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public reason?: string,
  ) {
    super(message);
  }
}
