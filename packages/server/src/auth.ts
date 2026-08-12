import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Principal, PrincipalKind } from '@greenroom/shared';
import type { Config } from './config.js';
import type { Store } from './store.js';
import { sha256Hex, HttpError } from './util.js';

export const SESSION_COOKIE = 'gr_session';

export interface AppEnv {
  Variables: {
    principal: Principal | null;
  };
}

const sameSecret = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(sha256Hex(a)), Buffer.from(sha256Hex(b)));

/** Resolve the caller: bearer token (env admin key or DB token) or reviewer cookie. */
export function principalMiddleware(store: Store, config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let principal: Principal | null = null;

    const auth = c.req.header('authorization');
    if (auth?.toLowerCase().startsWith('bearer ')) {
      const raw = auth.slice(7).trim();
      if (raw && sameSecret(raw, config.adminKey)) {
        principal = { kind: 'admin', id: 'env-admin', name: 'Admin' };
      } else {
        const token = store.findToken(raw);
        if (token) principal = { kind: token.kind, id: token.id, name: token.name };
      }
    }

    if (!principal) {
      const sessionId = getCookie(c, SESSION_COOKIE);
      if (sessionId) {
        const reviewer = store.sessionReviewer(sessionId);
        if (reviewer)
          principal = { kind: 'reviewer', id: reviewer.id, name: reviewer.name, role: reviewer.role };
      }
    }

    c.set('principal', principal);
    await next();
  };
}

export function requirePrincipal(...kinds: PrincipalKind[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get('principal');
    if (!principal) throw new HttpError(401, 'Authentication required.');
    if (kinds.length && !kinds.includes(principal.kind)) {
      throw new HttpError(403, `This action requires: ${kinds.join(' or ')}.`);
    }
    await next();
  };
}

export function principalOf(c: { get: (k: 'principal') => Principal | null }): Principal {
  const principal = c.get('principal');
  if (!principal) throw new HttpError(401, 'Authentication required.');
  return principal;
}
