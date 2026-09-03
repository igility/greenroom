import type { Build, Story, StoryState, ThreadState } from '@igility/greenroom-shared';

export interface FeedbackItem {
  thread: {
    id: string;
    storyId: string;
    /** The surface it was said on — a contact sheet, when the tile clicked belonged to
     *  another story. Null when the comment was left on the story itself. */
    seenOnStoryId: string | null;
    buildId: string;
    state: ThreadState;
    /** The server sends the full pin; this used to declare only three of its fields, so
     *  the viewport a comment was written in was arriving and being dropped on the floor
     *  by the type rather than by any decision. */
    pin: {
      selector: string;
      x: number;
      y: number;
      viewportWidth: number;
      viewportHeight: number;
      viewportLabel: string | null;
    } | null;
    screenshotAttachmentId: string | null;
    createdBy: { kind: string; name: string };
    createdAt: string;
  };
  story: {
    storyId: string;
    /** Variant title, e.g. "Components/Navigation/SideNav / Grouped". */
    title: string;
    /** The component — what the reviewer recognises and what approval now moves. */
    componentTitle: string;
    importPath: string;
    state: StoryState;
  };
  messages: { id: string; author: { kind: string; name: string }; kind: string; body: string; createdAt: string }[];
}

export interface Conn {
  url: string;
  /** Omitted when the sidecar is serving this page itself — see below. */
  token?: string;
}

/**
 * Reads a build id out of a legacy pinned path (`/builds/<id>/`).
 *
 * Those addresses are retired — the sidecar redirects them to the root, which names no
 * build — so this now only matches a page loaded before that shipped. The live carrier is
 * the `greenroom-build` meta tag; see `currentBuildId`.
 */
export function buildIdFromPath(pathname: string): string | null {
  const m = /^\/builds\/([^/]+)\//.exec(pathname);
  return m ? m[1]! : null;
}

export class Sidecar {
  constructor(private conn: Conn) {}

  /**
   * A Storybook hosted by the sidecar is same-origin with it, so the reviewer's
   * session cookie — already set by the magic link they followed — authenticates
   * these calls and no token is needed. That is the whole reason a client can be
   * dropped into their own Storybook with review working and nothing to configure.
   *
   * The cookie only rides same-origin requests. Cross-origin the panel still uses a
   * bearer token, and must NOT send credentials: `cors()` answers with
   * `Access-Control-Allow-Origin: *`, which the browser rejects outright on a
   * credentialed request.
   */
  private get sameOrigin(): boolean {
    return typeof location !== 'undefined' && this.conn.url.replace(/\/$/, '') === location.origin;
  }

  private async req<T>(method: string, path: string, body?: unknown, contentType?: string): Promise<T> {
    const res = await fetch(`${this.conn.url.replace(/\/$/, '')}${path}`, {
      method,
      credentials: this.sameOrigin ? 'include' : 'omit',
      headers: {
        ...(this.conn.token ? { authorization: `Bearer ${this.conn.token}` } : {}),
        ...(body !== undefined
          ? { 'content-type': contentType ?? 'application/json' }
          : {}),
      },
      body:
        body === undefined
          ? undefined
          : contentType
            ? (body as BodyInit)
            : JSON.stringify(body),
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `${method} ${path} failed (${res.status})`);
    return json;
  }

  health() {
    return this.req<{ ok: boolean }>('GET', '/api/health');
  }
  story(storyId: string) {
    return this.req<{ story: Story & { changedSinceApproval?: boolean } }>(
      'GET',
      `/api/stories/${encodeURIComponent(storyId)}`,
    );
  }
  /** Every thread in the review, not just the story on screen. Without this a reviewer
   *  part-way through a few hundred stories has no way to see what they have already
   *  said — each comment is only visible by navigating back to the story it was left on,
   *  which requires remembering where that was. */
  allFeedback() {
    return this.req<{ feedback: FeedbackItem[] }>('GET', '/api/feedback');
  }

  /** Every story and its workflow state. The status map is otherwise built purely from
   *  threads, so approval — the one state a reviewer most wants to see at a glance on a
   *  sheet — never appeared on a tile at all. */
  stories() {
    return this.req<{
      stories: (Story & {
        openThreads: number;
        unresolvedThreads: number;
        /** Approved, and its render has moved since. Never true for anything else. */
        changedSinceApproval: boolean;
      })[];
    }>('GET', '/api/stories');
  }

  /** Other components whose render has also moved since they were approved. Offered
   *  only after the reviewer has re-confirmed one, so the decision rests on something
   *  they just looked at. */
  alsoChanged(storyId: string) {
    return this.req<{ stories: Story[] }>(
      'GET',
      `/api/stories/${encodeURIComponent(storyId)}/also-changed`,
    );
  }

  /** Approve those others on the strength of the one reviewed. Partial by design —
   *  anything carrying a new objection comes back in `skipped`, not as a failure. */
  batchApprove(storyIds: string[], becauseOf: string, buildId: string) {
    return this.req<{
      approved: string[];
      skipped: { storyId: string; reason: string; message: string }[];
    }>('POST', '/api/stories/batch-approve', { storyIds, becauseOf, buildId });
  }

  feedbackForStory(storyId: string) {
    return this.req<{ feedback: FeedbackItem[] }>(
      'GET',
      `/api/feedback?storyId=${encodeURIComponent(storyId)}`,
    );
  }
  latestBuild() {
    return this.req<{ build: Build | null }>('GET', '/api/builds/latest');
  }

  /**
   * The build the reviewer is actually looking at — which is not necessarily the newest
   * one on the server.
   *
   * A reviewer link pins a build id into the URL on purpose, so a tab left open on an
   * older build is the designed behaviour rather than an edge case. Asking the server for
   * `latest` at submit time therefore stamps whatever was uploaded most recently, while
   * the pin coordinates and the screenshot both come from the render still on screen.
   * Nothing errors and the thread looks normal, which is what makes it worth a method of
   * its own rather than a call site each.
   *
   * 🔴 The path wins outright when it carries an id. Falling back to `latest` on a failed
   * lookup would reintroduce exactly the silent mis-stamp this exists to prevent; the
   * fallback is only for the no-id case, which is local dev on `localhost:6006`.
   */
  async currentBuildId(): Promise<string | null> {
    const fromPath = buildIdFromPath(
      typeof window === 'undefined' ? '' : window.location.pathname,
    );
    if (fromPath) return fromPath;
    // The reviewer's address names no build at all, so the sidecar stamps it into the
    // served document instead. Same authority, different carrier: both say which build
    // is ON SCREEN, which asking the server does not — the newest can have moved on
    // under a tab that has not reloaded.
    const fromMeta =
      typeof document === 'undefined'
        ? null
        : (document.querySelector('meta[name="greenroom-build"]')?.getAttribute('content') ??
          null);
    if (fromMeta) return fromMeta;
    return (await this.latestBuild()).build?.id ?? null;
  }
  setStatus(storyId: string, to: StoryState, buildId?: string, note?: string) {
    return this.req<{ story: Story }>('POST', `/api/stories/${encodeURIComponent(storyId)}/status`, {
      to,
      buildId,
      note,
    });
  }
  reply(threadId: string, body: string) {
    return this.req('POST', `/api/threads/${threadId}/messages`, { body });
  }
  setThreadState(threadId: string, state: ThreadState) {
    return this.req('POST', `/api/threads/${threadId}/state`, { state });
  }
  /**
   * An attachment as an object URL. It cannot be an `<img src>` straight at the API:
   * the endpoint requires a principal, and an image request carries no Authorization
   * header. Fetching it through the same path as every other call means it works
   * whether the panel is authenticated by cookie or by token.
   *
   * The caller owns the URL and must revoke it.
   */
  async attachmentObjectUrl(id: string): Promise<string> {
    const res = await fetch(
      `${this.conn.url.replace(/\/$/, '')}/api/attachments/${encodeURIComponent(id)}`,
      {
        credentials: this.sameOrigin ? 'include' : 'omit',
        headers: this.conn.token ? { authorization: `Bearer ${this.conn.token}` } : {},
      },
    );
    if (!res.ok) throw new Error(`attachment ${id} failed (${res.status})`);
    return URL.createObjectURL(await res.blob());
  }

  async uploadScreenshot(dataUrl: string): Promise<string> {
    const [meta, b64] = dataUrl.split(',');
    const contentType = meta?.match(/data:([^;]+)/)?.[1] ?? 'image/png';
    const bytes = Uint8Array.from(atob(b64 ?? ''), (ch) => ch.charCodeAt(0));
    const out = await this.req<{ attachmentId: string }>('POST', '/api/attachments', bytes, contentType);
    return out.attachmentId;
  }
  createThread(input: {
    storyId: string;
    /** The tile that was clicked, when the story declares regions. The server files
     *  the comment against that component and records this surface as where it was
     *  said; null, or an id that does not resolve, leaves it on the surface. */
    regionStoryId?: string | null;
    buildId: string;
    body: string;
    pin?: {
      selector: string;
      x: number;
      y: number;
      viewportWidth: number;
      viewportHeight: number;
      /** Storybook's named viewport when one is selected — what makes "broken on
       *  mobile" answerable rather than inferred from a pixel count. */
      viewportLabel?: string | null;
    };
    args?: Record<string, unknown>;
    screenshotAttachmentId?: string;
  }) {
    return this.req<{ feedback: FeedbackItem }>('POST', '/api/threads', input);
  }
}
