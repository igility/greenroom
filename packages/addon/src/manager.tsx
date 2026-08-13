import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { addons, types, useChannel, useParameter, useStorybookApi } from 'storybook/manager-api';
import type { Story, StoryState } from '@igility/greenroom-shared';
import { Sidecar, type Conn, type FeedbackItem } from './api.js';
import { ADDON_ID, EVENTS, PANEL_ID, PARAM_KEY, type CapturedPin } from './constants.js';

const CONN_KEY = 'greenroom-conn';

const STATE_LABEL: Record<StoryState, string> = {
  in_review: 'In review',
  changes_requested: 'Changes requested',
  addressed: 'Addressed — pending re-review',
  approved: 'Approved',
  needs_reconfirm: 'Needs re-confirmation',
};

const STATE_COLOR: Record<StoryState, string> = {
  in_review: '#5c6470',
  changes_requested: '#d97706',
  addressed: '#2563eb',
  approved: '#16a34a',
  needs_reconfirm: '#dc2626',
};

const ACTIONS: Record<StoryState, { label: string; to: StoryState }[]> = {
  in_review: [
    { label: 'Approve', to: 'approved' },
    { label: 'Request changes', to: 'changes_requested' },
  ],
  changes_requested: [
    { label: 'Approve', to: 'approved' },
    { label: 'Back to review', to: 'in_review' },
  ],
  addressed: [
    { label: 'Approve', to: 'approved' },
    { label: 'Request changes', to: 'changes_requested' },
  ],
  approved: [
    { label: 'Reopen', to: 'in_review' },
    { label: 'Request changes', to: 'changes_requested' },
  ],
  needs_reconfirm: [
    { label: 'Approve again', to: 'approved' },
    { label: 'Request changes', to: 'changes_requested' },
  ],
};

const box: React.CSSProperties = { padding: 14, font: '13px/1.5 system-ui', color: '#1f2430' };
const btn: React.CSSProperties = {
  font: '600 12px/1 system-ui',
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid #d9dee6',
  background: '#fff',
  cursor: 'pointer',
  marginRight: 6,
};
const input: React.CSSProperties = {
  font: '13px/1.4 system-ui',
  padding: '7px 9px',
  border: '1px solid #d9dee6',
  borderRadius: 6,
  width: '100%',
  boxSizing: 'border-box',
};

function loadConn(): Conn | null {
  try {
    const raw = localStorage.getItem(CONN_KEY);
    return raw ? (JSON.parse(raw) as Conn) : null;
  } catch {
    return null;
  }
}

const ConnectForm: React.FC<{ defaultUrl: string; onConnect: (c: Conn) => void }> = ({
  defaultUrl,
  onConnect,
}) => {
  const [url, setUrl] = useState(defaultUrl);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const connect = async () => {
    const conn = { url: url.trim(), token: token.trim() };
    try {
      await new Sidecar(conn).health();
      localStorage.setItem(CONN_KEY, JSON.stringify(conn));
      onConnect(conn);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the sidecar.');
    }
  };
  return (
    <div style={{ ...box, maxWidth: 420 }}>
      <p style={{ marginTop: 0 }}>
        Connect this panel to a Greenroom sidecar to see and leave review feedback.
      </p>
      <label style={{ display: 'block', marginBottom: 8 }}>
        Sidecar URL
        <input style={input} value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label style={{ display: 'block', marginBottom: 8 }}>
        API token
        <input
          style={input}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="admin or agent token"
        />
      </label>
      <button style={{ ...btn, background: '#2563eb', color: '#fff', borderColor: '#2563eb' }} onClick={connect}>
        Connect
      </button>
      {error ? <p style={{ color: '#dc2626' }}>{error}</p> : null}
    </div>
  );
};

const Thread: React.FC<{ item: FeedbackItem; client: Sidecar; onChanged: () => void }> = ({
  item,
  client,
  onChanged,
}) => {
  const [reply, setReply] = useState('');
  const send = async () => {
    if (!reply.trim()) return;
    await client.reply(item.thread.id, reply.trim());
    setReply('');
    onChanged();
  };
  return (
    <div style={{ border: '1px solid #e3e7ee', borderRadius: 8, padding: 10, marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>
          {item.thread.state === 'open' ? '● ' : item.thread.state === 'addressed' ? '◐ ' : '○ '}
          {item.thread.pin ? <code style={{ fontSize: 11 }}>{item.thread.pin.selector}</code> : 'General'}
        </span>
        <span style={{ color: '#5c6470', fontSize: 11 }}>{item.thread.state}</span>
      </div>
      {item.messages.map((m) => (
        <p key={m.id} style={{ margin: '4px 0' }}>
          <strong style={{ color: m.author.kind === 'agent' ? '#7c3aed' : '#1f2430' }}>
            {m.author.name}
            {m.author.kind === 'agent' ? ' (agent)' : ''}:
          </strong>{' '}
          {m.body}
        </p>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          style={{ ...input, flex: 1 }}
          placeholder="Reply…"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        {item.thread.state !== 'resolved' ? (
          <button style={btn} onClick={() => client.setThreadState(item.thread.id, 'resolved').then(onChanged)}>
            Resolve
          </button>
        ) : null}
      </div>
    </div>
  );
};

const Panel: React.FC<{ active: boolean }> = ({ active }) => {
  const api = useStorybookApi();
  const param = useParameter<{ url?: string }>(PARAM_KEY, {});
  const storyId = (api.getCurrentStoryData?.() as { id?: string } | undefined)?.id;

  const [conn, setConn] = useState<Conn | null>(loadConn);
  const client = useMemo(() => (conn ? new Sidecar(conn) : null), [conn]);
  const [story, setStory] = useState<Story | null>(null);
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<CapturedPin | null>(null);
  const [comment, setComment] = useState('');
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const emit = useChannel({
    [EVENTS.PIN_CAPTURED]: (captured: CapturedPin) => setPending(captured),
  });

  useEffect(() => {
    if (!client || !storyId) return;
    let live = true;
    client
      .story(storyId)
      .then((r) => live && (setStory(r.story), setNotice('')))
      .catch((e: Error) =>
        live &&
        (setStory(null),
        setNotice(
          /not found/i.test(e.message)
            ? 'This story is not in the review store yet — upload a build.'
            : e.message,
        )),
      );
    client
      .feedbackForStory(storyId)
      .then((r) => live && setFeedback(r.feedback))
      .catch(() => live && setFeedback([]));
    return () => {
      live = false;
    };
  }, [client, storyId, tick]);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [active, refresh]);

  if (!active) return null;
  if (!conn) {
    return <ConnectForm defaultUrl={param.url ?? 'http://localhost:4788'} onConnect={setConn} />;
  }
  if (!client || !storyId) return <div style={box}>Select a story.</div>;

  const act = async (to: StoryState) => {
    try {
      const build = (await client.latestBuild()).build;
      const r = await client.setStatus(storyId, to, to === 'approved' ? (build?.id ?? undefined) : undefined);
      setStory(r.story);
      refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Action failed.');
    }
  };

  const submitPin = async () => {
    if (!pending || !comment.trim()) return;
    try {
      const build = (await client.latestBuild()).build;
      if (!build) throw new Error('No builds uploaded yet — run `greenroom upload` first.');
      const screenshotAttachmentId = pending.screenshotDataUrl
        ? await client.uploadScreenshot(pending.screenshotDataUrl)
        : undefined;
      await client.createThread({
        storyId: pending.storyId,
        buildId: build.id,
        body: comment.trim(),
        pin: pending.pin,
        args: pending.args,
        screenshotAttachmentId,
      });
      setPending(null);
      setComment('');
      refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not create the thread.');
    }
  };

  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        {story ? (
          <>
            <span
              style={{
                fontWeight: 700,
                color: '#fff',
                background: STATE_COLOR[story.state],
                borderRadius: 999,
                padding: '4px 10px',
                fontSize: 11,
              }}
            >
              {STATE_LABEL[story.state]}
            </span>
            {ACTIONS[story.state].map((a) => (
              <button key={a.to} style={btn} onClick={() => act(a.to)}>
                {a.label}
              </button>
            ))}
          </>
        ) : (
          <span style={{ color: '#5c6470' }}>{notice || 'Loading…'}</span>
        )}
        <span style={{ flex: 1 }} />
        <button style={btn} onClick={() => emit(EVENTS.ENTER_PIN_MODE)}>
          📌 Comment on element
        </button>
        <button
          style={{ ...btn, marginRight: 0 }}
          title="Disconnect from sidecar"
          onClick={() => {
            localStorage.removeItem(CONN_KEY);
            setConn(null);
          }}
        >
          ⏏
        </button>
      </div>

      {story && notice ? <p style={{ color: '#dc2626' }}>{notice}</p> : null}

      {pending ? (
        <div style={{ border: '2px solid #2563eb', borderRadius: 8, padding: 10, marginBottom: 12 }}>
          <p style={{ margin: '0 0 6px', fontWeight: 600 }}>
            New comment on <code style={{ fontSize: 11 }}>{pending.pin.selector}</code>
          </p>
          {pending.screenshotDataUrl ? (
            <img
              src={pending.screenshotDataUrl}
              alt="Captured story state"
              style={{ maxWidth: '100%', maxHeight: 140, borderRadius: 6, marginBottom: 6 }}
            />
          ) : null}
          <textarea
            style={{ ...input, minHeight: 60 }}
            placeholder="What should change?"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div style={{ marginTop: 6 }}>
            <button
              style={{ ...btn, background: '#2563eb', color: '#fff', borderColor: '#2563eb' }}
              onClick={submitPin}
            >
              Post comment
            </button>
            <button style={btn} onClick={() => setPending(null)}>
              Discard
            </button>
          </div>
        </div>
      ) : null}

      {feedback.length ? (
        feedback.map((item) => (
          <Thread key={item.thread.id} item={item} client={client} onChanged={refresh} />
        ))
      ) : (
        <p style={{ color: '#5c6470' }}>No feedback threads on this story yet.</p>
      )}
    </div>
  );
};

addons.register(ADDON_ID, () => {
  addons.add(PANEL_ID, {
    type: types.PANEL,
    title: 'Review',
    render: ({ active }) => <Panel active={!!active} />,
  });
});
