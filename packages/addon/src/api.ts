import type { Build, Story, StoryState, ThreadState } from '@igility/greenroom-shared';

export interface FeedbackItem {
  thread: {
    id: string;
    storyId: string;
    buildId: string;
    state: ThreadState;
    pin: { selector: string; x: number; y: number } | null;
    screenshotAttachmentId: string | null;
    createdBy: { kind: string; name: string };
    createdAt: string;
  };
  story: { storyId: string; title: string; importPath: string; state: StoryState };
  messages: { id: string; author: { kind: string; name: string }; kind: string; body: string; createdAt: string }[];
}

export interface Conn {
  url: string;
  /** Omitted when the sidecar is serving this page itself — see below. */
  token?: string;
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
    return this.req<{ story: Story }>('GET', `/api/stories/${encodeURIComponent(storyId)}`);
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
    pin?: { selector: string; x: number; y: number; viewportWidth: number; viewportHeight: number };
    args?: Record<string, unknown>;
    screenshotAttachmentId?: string;
  }) {
    return this.req<{ feedback: FeedbackItem }>('POST', '/api/threads', input);
  }
}
