import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { addons, types, useChannel, useParameter, useStorybookApi } from 'storybook/manager-api';
import { Button, IconButton, TooltipNote, WithTooltip } from 'storybook/internal/components';
import { useTheme, type Theme } from 'storybook/theming';
import { CheckIcon, EditIcon, PinAltIcon, PowerIcon, UndoIcon } from '@storybook/icons';
import type { Story, StoryState } from '@igility/greenroom-shared';
import { Sidecar, type Conn, type FeedbackItem } from './api.js';
import { ADDON_ID, EVENTS, PANEL_ID, PARAM_KEY, type CapturedPin } from './constants.js';

/**
 * Controls are Storybook's own `IconButton` with its own tooltip, not styled `<button>`s.
 * Hand-rolled buttons set a background without setting a colour, so the label inherited
 * whatever the active Storybook theme used and went invisible — white on white under a
 * light theme. Borrowing the host's components means the panel follows any theme the host
 * picks, for free, and the hover labels match the ones on Storybook's own toolbars.
 */
const Action: React.FC<{
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}> = ({ label, icon, onClick, disabled }) => (
  <WithTooltip
    hasChrome={false}
    trigger="hover"
    tooltip={<TooltipNote note={label} />}
  >
    <IconButton aria-label={label} onClick={onClick} disabled={disabled}>
      {icon}
    </IconButton>
  </WithTooltip>
);

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

/** The label is the hover tooltip, so it stays the full sentence rather than being
 *  shortened to fit a button. */
const APPROVE = { label: 'Approve', to: 'approved' as StoryState, icon: <CheckIcon /> };
const REQUEST = {
  label: 'Request changes',
  to: 'changes_requested' as StoryState,
  icon: <EditIcon />,
};

const ACTIONS: Record<StoryState, { label: string; to: StoryState; icon: React.ReactNode }[]> = {
  in_review: [APPROVE, REQUEST],
  changes_requested: [
    APPROVE,
    { label: 'Back to review', to: 'in_review', icon: <UndoIcon /> },
  ],
  addressed: [APPROVE, REQUEST],
  approved: [{ label: 'Reopen', to: 'in_review', icon: <UndoIcon /> }, REQUEST],
  needs_reconfirm: [{ ...APPROVE, label: 'Approve again' }, REQUEST],
};

/*
 * Every colour comes from the host's active Storybook theme, never a literal.
 *
 * Hardcoding them is what produced empty white buttons on a light theme: a fixed
 * white background with no colour set, so the label inherited the theme's text colour
 * and vanished. The fix is not better literals — a design system can be any colour,
 * and this panel renders inside someone else's. Read the theme and the panel belongs
 * wherever it is installed, the way the accessibility addon does.
 */
const boxStyle = (t: Theme): React.CSSProperties => ({
  padding: 14,
  font: `13px/1.5 ${t.typography.fonts.base}`,
  color: t.color.defaultText,
});

const inputStyle = (t: Theme): React.CSSProperties => ({
  font: `13px/1.4 ${t.typography.fonts.base}`,
  padding: '7px 9px',
  border: `1px solid ${t.appBorderColor}`,
  borderRadius: t.appBorderRadius,
  background: t.input.background,
  color: t.input.color,
  width: '100%',
  boxSizing: 'border-box',
});

function loadConn(): Conn | null {
  try {
    const raw = localStorage.getItem(CONN_KEY);
    return raw ? (JSON.parse(raw) as Conn) : null;
  } catch {
    return null;
  }
}

/**
 * A build hosted by the sidecar is served from `/builds/<id>/`, which means this
 * Storybook and the review store are the same origin and the reviewer's session
 * cookie already authenticates. Detect that and connect without asking.
 *
 * This is what lets a client follow one magic link and land in the host's own
 * Storybook — its branding, its navigation, its curation — with review live and
 * nothing to configure. Handing a client a URL and an API token was never going to
 * happen. Anywhere else (a developer running `storybook dev`), the form still
 * appears and a token is still required.
 */
function hostedConn(): Conn | null {
  if (typeof location === 'undefined') return null;
  return /^\/builds\/[^/]+\//.test(location.pathname) ? { url: location.origin } : null;
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
  const theme = useTheme();
  return (
    <div style={{ ...boxStyle(theme), maxWidth: 420 }}>
      <p style={{ marginTop: 0 }}>
        Connect this panel to a Greenroom sidecar to see and leave review feedback.
      </p>
      <label style={{ display: 'block', marginBottom: 8 }}>
        Sidecar URL
        <input style={inputStyle(theme)} value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label style={{ display: 'block', marginBottom: 8 }}>
        API token
        <input
          style={inputStyle(theme)}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="admin or agent token"
        />
      </label>
      <Button variant="solid" size="small" onClick={connect}>
        Connect
      </Button>
      {error ? <p style={{ color: theme.color.negative }}>{error}</p> : null}
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
  const theme = useTheme();
  return (
    <div
      style={{
        border: `1px solid ${theme.appBorderColor}`,
        borderRadius: theme.appBorderRadius,
        padding: 10,
        marginBottom: 10,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>
          {item.thread.state === 'open' ? '● ' : item.thread.state === 'addressed' ? '◐ ' : '○ '}
          {item.thread.pin ? <code style={{ fontSize: 11 }}>{item.thread.pin.selector}</code> : 'General'}
        </span>
        <span style={{ color: theme.textMutedColor, fontSize: 11 }}>{item.thread.state}</span>
      </div>
      {item.messages.map((m) => (
        <p key={m.id} style={{ margin: '4px 0' }}>
          <strong
            style={{
              color: m.author.kind === 'agent' ? theme.color.secondary : theme.color.defaultText,
            }}
          >
            {m.author.name}
            {m.author.kind === 'agent' ? ' (agent)' : ''}:
          </strong>{' '}
          {m.body}
        </p>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          style={{ ...inputStyle(theme), flex: 1 }}
          placeholder="Reply…"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        {item.thread.state !== 'resolved' ? (
          <Button
            size="small"
            onClick={() => void client.setThreadState(item.thread.id, 'resolved').then(onChanged)}
          >
            Resolve
          </Button>
        ) : null}
      </div>
    </div>
  );
};

const Panel: React.FC<{ active: boolean }> = ({ active }) => {
  const api = useStorybookApi();
  const param = useParameter<{ url?: string }>(PARAM_KEY, {});
  const storyId = (api.getCurrentStoryData?.() as { id?: string } | undefined)?.id;

  // Hosted wins over anything stored: a reviewer arriving on a magic link must not
  // inherit some developer's leftover sidecar from a previous visit in this browser.
  const hosted = useMemo(hostedConn, []);
  const [conn, setConn] = useState<Conn | null>(() => hosted ?? loadConn());
  const client = useMemo(() => (conn ? new Sidecar(conn) : null), [conn]);
  const [story, setStory] = useState<Story | null>(null);
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<CapturedPin | null>(null);
  const [comment, setComment] = useState('');
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const theme = useTheme();

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
  if (!client || !storyId) return <div style={boxStyle(theme)}>Select a story.</div>;

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
        // The tile clicked, not the surface it sits on. `preview.ts` resolves this in
        // both the shell and here; the panel used to drop it, which filed every
        // comment left on a contact sheet against the sheet — a page containing no
        // code — instead of the component that needs the fix.
        regionStoryId: pending.regionStoryId,
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
    <div style={boxStyle(theme)}>
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
              <Action key={a.to} label={a.label} icon={a.icon} onClick={() => act(a.to)} />
            ))}
          </>
        ) : (
          <span style={{ color: '#5c6470' }}>{notice || 'Loading…'}</span>
        )}
        {/* Kept with the other controls, not pushed to the far edge by a flex spacer.
            On a wide window that put the panel's primary action a thousand pixels from
            everything else, and the first person to use it concluded there was no way
            to leave a comment at all. */}
        <Action
          label="Comment on element"
          icon={<PinAltIcon />}
          onClick={() => emit(EVENTS.ENTER_PIN_MODE)}
        />
        <span style={{ flex: 1 }} />
        {/* Nothing to log out of when the sidecar is serving this page: there is no
            stored connection, and dropping it would strand a reviewer on a connect
            form asking for a token they were never given. */}
        {hosted ? null : (
          <Action
            label="Log out of this sidecar"
            icon={<PowerIcon />}
            onClick={() => {
              localStorage.removeItem(CONN_KEY);
              setConn(null);
            }}
          />
        )}
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
            style={{ ...inputStyle(theme), minHeight: 60 }}
            placeholder="What should change?"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div style={{ marginTop: 6 }}>
            <Button variant="solid" size="small" onClick={submitPin}>
              Post comment
            </Button>
            <Button size="small" onClick={() => setPending(null)}>
              Discard
            </Button>
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
    title: 'Greenroom Review',
    render: ({ active }) => <Panel active={!!active} />,
  });
});
