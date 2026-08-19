import type {
  Build,
  Message,
  Pin,
  Story,
  StoryKind,
  StoryState,
  Thread,
  ThreadState,
} from '@igility/greenroom-shared';

/** One thread of human review feedback plus the story it hangs on. */
export interface FeedbackItem {
  thread: Thread;
  story: Pick<Story, 'storyId' | 'title' | 'componentTitle' | 'importPath' | 'state'>;
  messages: Message[];
}

export type StoryWithCounts = Story & {
  /** Threads still awaiting a first response. The reviewer's attention badge. */
  openThreads: number;
  /**
   * Threads no human has accepted — including ones an agent has already answered and
   * marked addressed. This is what blocks approval, so it is the count an agent needs
   * to predict whether its work has actually cleared the variant.
   */
  unresolvedThreads: number;
  /** Approved, and the render has moved since. Never true for anything else. */
  changedSinceApproval: boolean;
};

export class SidecarError extends Error {
  constructor(
    message: string,
    public status: number,
    public reason?: string,
  ) {
    super(message);
    this.name = 'SidecarError';
  }
}

export interface SidecarClientOptions {
  /** Sidecar base URL, e.g. http://localhost:4788 */
  url: string;
  /** Bearer token (an admin-minted agent token). */
  token: string;
}

/** Thin typed client for the Greenroom sidecar HTTP API. */
export class SidecarClient {
  private baseUrl: string;
  private token: string;

  constructor(options: SidecarClientOptions) {
    this.baseUrl = options.url.replace(/\/$/, '');
    this.token = options.token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      let reason: string | undefined;
      try {
        const body = (await res.json()) as { error?: string; reason?: string };
        if (body.error) message = body.error;
        reason = body.reason;
      } catch {
        // non-JSON error body; keep the status line
      }
      throw new SidecarError(message, res.status, reason);
    }
    return (await res.json()) as T;
  }

  health(): Promise<{ ok: boolean }> {
    return this.request('/api/health');
  }

  listFeedback(
    filter: { state?: ThreadState; storyId?: string } = {},
  ): Promise<{ feedback: FeedbackItem[] }> {
    const params = new URLSearchParams();
    if (filter.state) params.set('state', filter.state);
    if (filter.storyId) params.set('storyId', filter.storyId);
    const qs = params.toString();
    return this.request(`/api/feedback${qs ? `?${qs}` : ''}`);
  }

  getThread(threadId: string): Promise<{ feedback: FeedbackItem }> {
    return this.request(`/api/threads/${encodeURIComponent(threadId)}`);
  }

  postMessage(threadId: string, body: string): Promise<{ message: Message }> {
    return this.request(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  me(): Promise<{ principal: { kind: string; id: string; name: string; role?: string } }> {
    return this.request('/api/me');
  }

  setThreadState(
    threadId: string,
    state: ThreadState,
    note?: string,
  ): Promise<{ feedback: FeedbackItem }> {
    return this.request(`/api/threads/${encodeURIComponent(threadId)}/state`, {
      method: 'POST',
      body: JSON.stringify({ state, ...(note ? { note } : {}) }),
    });
  }

  listStories(
    filter: { state?: StoryState; kind?: StoryKind } = {},
  ): Promise<{ stories: StoryWithCounts[] }> {
    const params = new URLSearchParams();
    if (filter.state) params.set('state', filter.state);
    if (filter.kind) params.set('kind', filter.kind);
    const qs = params.toString();
    return this.request(`/api/stories${qs ? `?${qs}` : ''}`);
  }

  setStoryStatus(
    storyId: string,
    input: { to: StoryState; buildId?: string; note?: string },
  ): Promise<{ story: Story }> {
    return this.request(`/api/stories/${encodeURIComponent(storyId)}/status`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  latestBuild(): Promise<{ build: Build | null }> {
    return this.request('/api/builds/latest');
  }

  async screenshot(attachmentId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const res = await fetch(`${this.baseUrl}/api/attachments/${encodeURIComponent(attachmentId)}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new SidecarError(`Attachment ${attachmentId}: ${res.status} ${res.statusText}`, res.status);
    }
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}

export type { Build, Message, Pin, Story, StoryKind, StoryState, Thread, ThreadState };
