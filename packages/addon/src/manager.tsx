import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { addons, types, useChannel, useParameter, useStorybookApi } from 'storybook/manager-api';
import { Button, IconButton, TooltipNote, WithTooltip } from 'storybook/internal/components';
import { useTheme, type Theme } from 'storybook/theming';
import {
  CheckIcon,
  EditIcon,
  EyeCloseIcon,
  EyeIcon,
  PinAltIcon,
  PowerIcon,
  UndoIcon,
} from '@storybook/icons';
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
    <IconButton
      aria-label={label}
      disabled={disabled}
      // Storybook's IconButton renders `aria-disabled` but not the `disabled` attribute,
      // so a disabled-looking button is still fully clickable and its handler still runs.
      // The guard has to be here, or the approval gate would be advisory: the control
      // would look barred, fire anyway, and the reviewer would meet the server's 409.
      onClick={(e) => {
        if (disabled) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onClick();
      }}
    >
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

/** The captured shot, which is the whole point of a pinned comment and was never shown
 *  once the thread was posted — the composer displayed it, then it vanished. Fetched
 *  rather than linked, because the endpoint needs a principal and an `<img>` sends no
 *  Authorization header. */
const Shot: React.FC<{ client: Sidecar; attachmentId: string }> = ({ client, attachmentId }) => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let made: string | null = null;
    client
      .attachmentObjectUrl(attachmentId)
      .then((u) => {
        made = u;
        if (revoked) URL.revokeObjectURL(u);
        else setUrl(u);
      })
      .catch(() => setUrl(null));
    return () => {
      revoked = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [client, attachmentId]);
  if (!url) return null;
  return (
    <img
      src={url}
      alt="What the reviewer was looking at"
      style={{ maxWidth: '100%', maxHeight: 160, borderRadius: 6, margin: '2px 0 6px' }}
    />
  );
};

const Thread: React.FC<{
  item: FeedbackItem;
  client: Sidecar;
  onChanged: () => void;
  /** The story being looked at, so a thread about a different one can say which. */
  viewingStoryId?: string;
  /** Provided when surveying the whole review, so each thread can be jumped to. */
  onOpenStory?: (storyId: string) => void;
  /** Scroll the commented tile into view and throb its outline. */
  onReveal?: (regionStoryId: string, status?: { flagged?: boolean; resolved?: boolean }) => void;
  /** The story actually on screen, regardless of how the list is scoped. */
  currentStoryId?: string;
  /** Navigate even when not surveying everything. */
  goToStory?: (storyId: string) => void;
}> = ({
  item,
  client,
  onChanged,
  viewingStoryId,
  onOpenStory,
  onReveal,
  currentStoryId,
  goToStory,
}) => {
  const [reply, setReply] = useState('');
  const send = async () => {
    if (!reply.trim()) return;
    await client.reply(item.thread.id, reply.trim());
    setReply('');
    onChanged();
  };
  const theme = useTheme();

  /*
   * Where this comment can actually be seen.
   *
   * A tile only exists on the surface it was raised on: a comment left on a contact sheet
   * is ABOUT the component but the element carrying `data-greenroom-story` lives on the
   * sheet. So go to the surface first, then reveal the tile once it has rendered. Where
   * there is no surface — a pin on an ordinary story — there is no tile to throb, and
   * navigating there is the whole of what we can honestly do.
   */
  /** What this thread makes the tile: still needing an answer, or answered. Sent with the
   *  reveal so the halo matches the outline even before any status map has landed. */
  const threadStatus =
    item.thread.state === 'resolved' ? { resolved: true } : { flagged: true };
  const surfaceId = item.thread.seenOnStoryId ?? item.story.storyId;
  const regionId = item.thread.seenOnStoryId ? item.story.storyId : null;
  const show = () => {
    const elsewhere = !!currentStoryId && surfaceId !== currentStoryId;
    if (elsewhere) (goToStory ?? onOpenStory)?.(surfaceId);
    if (regionId && onReveal) {
      // Give the story time to mount before asking for a tile inside it.
      window.setTimeout(() => onReveal(regionId, threadStatus), elsewhere ? 900 : 0);
    }
  };

  return (
    <div
      style={{
        border: `1px solid ${theme.appBorderColor}`,
        borderRadius: theme.appBorderRadius,
        padding: 10,
        marginBottom: 10,
      }}
    >
      {/* The CSS selector is how the pin is anchored, not what the comment is about, and
          it used to be the headline: two wrapped lines of `div:nth-of-type(4) > …` in
          front of a reviewer who has no use for it. It stays on the title attribute for
          anyone debugging an anchor. What leads is what was said and where. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }} title={item.thread.pin?.selector ?? undefined}>
          {item.thread.state === 'open' ? '● ' : item.thread.state === 'addressed' ? '◐ ' : '○ '}
          {item.thread.pin ? 'Pinned comment' : 'General comment'}
          {item.story.storyId !== viewingStoryId ? (
            <span style={{ fontWeight: 400, color: theme.textMutedColor }}>
              {' · on '}
              {onOpenStory ? (
                <button
                  type="button"
                  onClick={() => onOpenStory(item.story.storyId)}
                  style={{
                    background: 'none',
                    border: 0,
                    padding: 0,
                    font: 'inherit',
                    color: theme.color.secondary,
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                >
                  {item.story.componentTitle || item.story.title}
                </button>
              ) : (
                item.story.componentTitle || item.story.title
              )}
            </span>
          ) : null}
        </span>
        <span style={{ color: theme.textMutedColor, fontSize: 11, whiteSpace: 'nowrap' }}>
          {item.thread.state}
        </span>
      </div>
      {item.thread.screenshotAttachmentId ? (
        onReveal || onOpenStory ? (
          // The picture is the most identifiable thing in the card and the most obvious
          // thing to reach for, so it goes to the story too rather than only the title.
          <button
            type="button"
            title={regionId ? `Show me on ${item.story.title}` : `Go to ${item.story.title}`}
            onClick={show}
            style={{ display: 'block', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
          >
            <Shot client={client} attachmentId={item.thread.screenshotAttachmentId} />
          </button>
        ) : (
          <Shot client={client} attachmentId={item.thread.screenshotAttachmentId} />
        )
      ) : null}
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
      {/* Resolve sits on its own row, not beside the reply box. Next to a text field it
          reads as that field's submit, so the obvious way to send a reply is the control
          that closes the thread instead — and closing someone else's open flag is not an
          action to put one mis-click away. */}
      {/* Reply sits against the field it submits, which is where a submit belongs.
          Resolve gets its own row: it closes the thread, and putting it beside the reply
          box made it read as that field's action — one mis-click from discarding
          someone else's open objection instead of answering it. */}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
        <input
          style={{ ...inputStyle(theme), flex: 1 }}
          placeholder="Reply…"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void send()}
        />
        <Button size="small" variant="solid" disabled={!reply.trim()} onClick={() => void send()}>
          Reply
        </Button>
      </div>
      {item.thread.state !== 'resolved' ? (
        <div style={{ marginTop: 6 }}>
          <Button
            size="small"
            onClick={() => void client.setThreadState(item.thread.id, 'resolved').then(onChanged)}
          >
            Resolve
          </Button>
        </div>
      ) : null}
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
  const [story, setStory] = useState<(Story & { changedSinceApproval?: boolean }) | null>(null);
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<CapturedPin | null>(null);
  const [comment, setComment] = useState('');
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const theme = useTheme();
  /** Story-scoped by default; 'all' surveys the whole review. */
  const [scope, setScope] = useState<'item' | 'story' | 'all'>('story');
  const [allCount, setAllCount] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  /** Which threads to show. Separate from the scope select, because "where to look" and
   *  "what state" are different questions and folding them into one control gives six
   *  combinations nobody can hold in their head. */
  const [threadState, setThreadState] = useState<'open' | 'resolved' | 'any'>('open');
  /** Whether tiles carry their review status. On by default: a reviewer opening a sheet
   *  wants to see at a glance which tiles already carry a comment, and discovering that
   *  requires knowing the control exists. The original argument for defaulting it off —
   *  that on a first pass nothing is settled, so every tile reads the same — only holds
   *  when nothing is flagged either, and in that case there is nothing to paint anyway. */
  const [showStatus, setShowStatus] = useState(true);
  /** The tile clicked on a survey page. Everything the panel does — status, actions,
   *  feedback — then applies to that component rather than the page, which is what makes
   *  a sheet a place you can approve from instead of only comment from. */
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  /** Stories carrying a comment nobody has resolved. The server refuses to approve these;
   *  the button is disabled so the refusal never has to be discovered by being told. */
  const [blocked, setBlocked] = useState<Map<string, number>>(new Map());
  const [verdicts, setVerdicts] = useState<Map<string, 'likely_unchanged' | 'changed' | 'unknown'>>(
    new Map(),
  );
  /** How many renditions each component has, keyed by its CSF file. Approving covers all
   *  of them, so the count is disclosed rather than left for the reviewer to discover. */
  const [variantsByFile, setVariantsByFile] = useState<Map<string, number>>(new Map());
  /** Pin mode is armed in the preview, but the reviewer armed it from a button in the
   *  manager — so that is where their focus is, and where Escape lands. The preview's own
   *  Escape listener is on the iframe's window and never sees it. */
  const [armed, setArmed] = useState(false);

  const emit = useChannel({
    [EVENTS.PIN_CAPTURED]: (captured: CapturedPin) => {
      setPending(captured);
      setArmed(false);
    },
    [EVENTS.CANCEL_PIN_MODE]: () => setArmed(false),
    [EVENTS.REGION_SELECTED]: (regionStoryId: string) => setSelectedRegion(regionStoryId),
  });

  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      emit(EVENTS.CANCEL_PIN_MODE);
      setArmed(false);
    };
    // Capture phase: Storybook's manager binds Escape of its own, and a shortcut that
    // closes the panel while a pin is armed would leave the preview waiting for a click
    // with no way left to call it off.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [armed, emit]);

  /** What the panel ACTS on — approve, request changes, status — is always the selected
   *  tile when there is one. What the panel LISTS is a separate question, answered by the
   *  scope below. Conflating them meant selecting a tile quietly narrowed the list while
   *  the dropdown still read "This page", so the control described the wrong thing. */
  const subjectId = selectedRegion ?? storyId;
  const listId = scope === 'item' ? (selectedRegion ?? storyId) : storyId;

  /** Status is derived from the threads already loaded, so it costs no extra request and
   *  cannot disagree with the list the reviewer is reading. Sent empty when switched off,
   *  which clears the paint rather than leaving a stale coat of it behind. */
  /** What the reviewer is judging. Approval moves the whole component, so naming the
   *  variant would describe something narrower than what the button does — the same
   *  mismatch as a control labelled "This page" while showing one tile. */
  const subjectName = story?.componentTitle || story?.title || '';
  const variantCount = story?.importPath ? (variantsByFile.get(story.importPath) ?? 1) : 1;

  /** Whether the page on screen is a survey page — asked of the story, not of the
   *  selected tile, so the option keeps saying "This page" while a tile is selected. */
  const sheetOnScreen = story?.kind === 'sheet' || !!selectedRegion;

  const statusMap = useMemo(() => {
    const map: Record<string, { flagged?: boolean; resolved?: boolean; settled?: boolean }> = {};
    for (const i of feedback) {
      const id = i.thread.storyId;
      const entry = (map[id] ??= {});
      if (i.thread.state === 'resolved') entry.resolved = entry.resolved ?? true;
      else {
        entry.flagged = true;
        entry.resolved = false;
      }
    }
    // Approval is a property of the story, not of any thread, so it has to come from the
    // stories list — building the map from comments alone meant an approved tile with no
    // comments on it carried no mark at all.
    for (const id of approved) (map[id] ??= {}).settled = true;
    return map;
  }, [feedback, approved]);

  useEffect(() => setSelectedRegion(null), [storyId]);

  /* Selecting a tile moves the list to it, and dropping the selection moves it back —
   * because both are things the reviewer did in the STORY, and the list should follow
   * where they are looking. Choosing a scope in the panel afterwards sticks: this only
   * fires when the selection itself changes, so interacting with Greenroom's own
   * interface never yanks the list out from under them. */
  useEffect(() => {
    if (selectedRegion) setScope('item');
    else setScope((v) => (v === 'item' ? 'story' : v));
  }, [selectedRegion]);

  useEffect(() => {
    // Statuses always go over; `paint` decides whether they are drawn. The preview needs
    // them regardless so revealing a tile can use its status colour even with paint off.
    emit(EVENTS.STATUS_MAP, { statuses: statusMap, paint: showStatus, selected: selectedRegion });
  }, [emit, showStatus, statusMap, storyId, selectedRegion]);

  useEffect(() => {
    if (!client || !subjectId || !listId) return;
    let live = true;
    client
      .story(subjectId)
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
    const wanted = scope === 'all' ? client.allFeedback() : client.feedbackForStory(listId);
    wanted.then((r) => live && setFeedback(r.feedback)).catch(() => live && setFeedback([]));
    // The total is fetched regardless, so the toggle can say how much is out there
    // rather than making the reviewer switch to find out.
    client
      .allFeedback()
      .then((r) => live && setAllCount(r.feedback.length))
      .catch(() => live && setAllCount(null));
    client
      .stories()
      .then(
        (r) =>
          live &&
          (setApproved(new Set(r.stories.filter((x) => x.state === 'approved').map((x) => x.storyId))),
          setBlocked(
            new Map(
              r.stories.filter((x) => x.unresolvedThreads > 0).map((x) => [x.storyId, x.unresolvedThreads]),
            ),
          ),
          setVariantsByFile(
            r.stories.reduce((m, x) => {
              if (x.kind !== 'sheet' && x.importPath) m.set(x.importPath, (m.get(x.importPath) ?? 0) + 1);
              return m;
            }, new Map<string, number>()),
          )),
      )
      .catch(() => undefined);
    client
      .reconfirmQueue()
      .then((r) => live && setVerdicts(new Map(r.items.map((i) => [i.story.storyId, i.verdict]))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, subjectId, listId, tick, scope]);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [active, refresh]);

  /** Searches what a reviewer would actually remember: the words they wrote, who wrote
   *  them, and the component it was about. Filtering happens over what is already loaded
   *  rather than round-tripping the server, so it stays responsive while typing. */
  const shown = useMemo(() => {
    const byState = feedback.filter((i) =>
      threadState === 'any'
        ? true
        : threadState === 'resolved'
          ? i.thread.state === 'resolved'
          : i.thread.state !== 'resolved',
    );
    const q = query.trim().toLowerCase();
    if (!q) return byState;
    return byState.filter(
      (i) =>
        i.story.title.toLowerCase().includes(q) ||
        i.story.storyId.toLowerCase().includes(q) ||
        i.messages.some(
          (m) => m.body.toLowerCase().includes(q) || m.author.name.toLowerCase().includes(q),
        ),
    );
  }, [feedback, query, threadState]);

  if (!active) return null;
  if (!conn) {
    return <ConnectForm defaultUrl={param.url ?? 'http://localhost:4788'} onConnect={setConn} />;
  }
  if (!client || !subjectId) return <div style={boxStyle(theme)}>Select a story.</div>;

  const act = async (to: StoryState) => {
    try {
      const build = (await client.latestBuild()).build;
      const r = await client.setStatus(subjectId, to, to === 'approved' ? (build?.id ?? undefined) : undefined);
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
    // The panel is a fixed-height drawer (or a narrow docked column) and the thread list
    // is unbounded — surveying all feedback puts every comment in the review here. Own
    // the scroll rather than letting the content run off the bottom with no way down.
    <div
      style={{
        ...boxStyle(theme),
        height: '100%',
        overflowY: 'auto',
        // Docked right, the panel is a narrow column. Without this a long story title —
        // "Components/Navigation/MobileNav In Phone Frame" — pushes the whole row
        // sideways and the controls leave the screen.
        overflowX: 'hidden',
        boxSizing: 'border-box',
        overflowWrap: 'anywhere',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          marginBottom: 10,
          minWidth: 0,
        }}
      >
        {story?.kind === 'sheet' && !selectedRegion ? (
          /*
           * A contact sheet is a survey surface, not a review unit: the server refuses to
           * approve one (NOT_A_REVIEW_UNIT) because signing off a page that contains no
           * code would sign off nothing. Offering the button anyway and letting the
           * server say no is a control that exists only to fail — the guard is right, the
           * affordance was not.
           */
          <span style={{ color: theme.textMutedColor, fontSize: 12 }}>
            Survey page — click a tile to review that component.
          </span>
        ) : story ? (
          <>
            <span
              style={{
                fontWeight: 700,
                color: '#fff',
                background: STATE_COLOR[story.state],
                borderRadius: 999,
                padding: '3px 8px',
                fontSize: 10,
                lineHeight: 1.5,
                // Docked to the side the panel gets narrow, and the longer labels —
                // "Needs re-confirmation", "Addressed — pending re-review" — wrapped the
                // pill into a two-line blob. It is a status marker, not a paragraph.
                whiteSpace: 'nowrap',
              }}
            >
              {STATE_LABEL[story.state]}
            </span>
            {ACTIONS[story.state].map((a) => {
              const outstanding = blocked.get(subjectId) ?? 0;
              const stopped = a.to === 'approved' && outstanding > 0;
              return (
                <Action
                  key={a.to}
                  label={
                    stopped
                      ? `${outstanding} unresolved comment${outstanding === 1 ? '' : 's'} — resolve ${outstanding === 1 ? 'it' : 'them'} before approving`
                      : a.label
                  }
                  icon={a.icon}
                  disabled={stopped}
                  onClick={() => act(a.to)}
                />
              );
            })}
          </>
        ) : (
          <span style={{ color: theme.textMutedColor }}>{notice || 'Loading…'}</span>
        )}

      {/* Kept with the other controls, not pushed to the far edge by a flex spacer.
            On a wide window that put the panel's primary action a thousand pixels from
            everything else, and the first person to use it concluded there was no way
            to leave a comment at all. */}
        <Action
          label={armed ? 'Cancel — pick nothing' : 'Comment on element'}
          icon={<PinAltIcon />}
          onClick={() => {
            // Clicking it again calls it off, which is the other thing a reviewer tries
            // when they change their mind and Escape is not obvious.
            emit(armed ? EVENTS.CANCEL_PIN_MODE : EVENTS.ENTER_PIN_MODE);
            setArmed((v) => !v);
          }}
        />
        <Action
          // Icon shows the current state, tooltip says what clicking will do — the way a
          // mute button shows a crossed speaker and reads "Unmute".
          label={showStatus ? 'Hide status on tiles' : 'Show status on tiles'}
          icon={showStatus ? <EyeIcon /> : <EyeCloseIcon />}
          onClick={() => setShowStatus((v) => !v)}
        />
        <span style={{ flex: '1 1 0', minWidth: 0 }} />
        {/* What the rail is showing. A toggle only ever announced the state you were
            about to move to, which reads as a command rather than a filter; a select
            states where you are. The first option is deliberately labelled by what the
            store actually returns: on a contact sheet that is the whole page — the sheet
            plus every tile on it — not one story. */}
        <select
          aria-label="Which comments to show"
          value={scope}
          onChange={(e) => setScope(e.target.value as 'story' | 'all')}
          style={{
            ...inputStyle(theme),
            width: 'auto',
            padding: '5px 6px',
            font: `12px/1.2 ${theme.typography.fonts.base}`,
          }}
        >
          {selectedRegion ? <option value="item">Current item</option> : null}
          <option value="story">{sheetOnScreen ? 'This page' : 'This story'}</option>
          <option value="all">
            {`All feedback${allCount === null ? '' : ` (${allCount})`}`}
          </option>
        </select>
        <select
          aria-label="Which comment states to show"
          value={threadState}
          onChange={(e) => setThreadState(e.target.value as 'open' | 'resolved' | 'any')}
          style={{
            ...inputStyle(theme),
            width: 'auto',
            padding: '5px 6px',
            font: `12px/1.2 ${theme.typography.fonts.base}`,
          }}
        >
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="any">Any state</option>
        </select>
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

      {story?.changedSinceApproval ? (
        /* The approval stands — this is a report, not a revocation. Withdrawing a
           sign-off because a render moved punished the reviewer for things they would
           call unrelated: another variant, a base component restyled underneath, a token
           retuned. What is true is that the thing on screen is no longer exactly what
           they signed off, and saying so is the honest half of that. */
        <div
          style={{
            border: `1px solid ${theme.color.warning ?? theme.appBorderColor}`,
            borderRadius: theme.appBorderRadius,
            padding: '8px 10px',
            marginBottom: 10,
            fontSize: 12,
            color: theme.color.defaultText,
          }}
        >
          Approved — but this has changed since you approved it.
        </div>
      ) : null}

      {selectedRegion && story ? (
        <div
          style={{
            marginBottom: 8,
            fontSize: 12,
            color: theme.textMutedColor,
            minWidth: 0,
            overflowWrap: 'anywhere',
          }}
        >
          Reviewing <strong style={{ color: theme.color.defaultText }}>{subjectName}</strong>
          {variantCount > 1 ? (
            <span title="Approving covers every variant of this component">
              {` · ${variantCount} variants`}
            </span>
          ) : null}
          {' · '}
          <button
            type="button"
            onClick={() => setSelectedRegion(null)}
            style={{
              background: 'none',
              border: 0,
              padding: 0,
              font: 'inherit',
              color: theme.color.secondary,
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            back to the page
          </button>
        </div>
      ) : null}

      {notice ? (
        /* Errors used to be bare red text that pushed the interface around and stayed
           until something else replaced them. A bordered, dismissible strip keeps the
           message legible and leaves the reviewer a way to put it down. */
        <div
          role="alert"
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            border: `1px solid ${theme.color.negative}`,
            borderRadius: theme.appBorderRadius,
            background: `${theme.color.negative}14`,
            color: theme.color.defaultText,
            padding: '8px 10px',
            marginBottom: 10,
            fontSize: 12,
          }}
        >
          <span style={{ flex: 1 }}>{notice}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setNotice('')}
            style={{
              background: 'none',
              border: 0,
              padding: 0,
              cursor: 'pointer',
              color: theme.textMutedColor,
              font: 'inherit',
            }}
          >
            ✕
          </button>
        </div>
      ) : null}

      <input
        aria-label="Search comments"
        placeholder="Search comments…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ ...inputStyle(theme), marginBottom: 10 }}
      />

      {pending ? (
        <div
          style={{
            border: `2px solid ${theme.color.secondary}`,
            borderRadius: theme.appBorderRadius,
            padding: 10,
            marginBottom: 12,
          }}
        >
          {/* The picture below is the subject; the selector is plumbing. Naming the tile
              when there is one tells the reviewer where this will be filed, which is the
              only part of the routing they benefit from seeing. */}
          <p style={{ margin: '0 0 6px', fontWeight: 600 }} title={pending.pin.selector}>
            New comment
            {pending.regionStoryId ? (
              <span style={{ fontWeight: 400, color: theme.textMutedColor }}>
                {' · on '}
                {pending.regionStoryId}
              </span>
            ) : null}
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

      {shown.length ? (
        shown.map((item) => (
          <Thread
            key={item.thread.id}
            item={item}
            client={client}
            onChanged={refresh}
            onOpenStory={scope === 'all' ? (id) => api.selectStory(id) : undefined}
            onReveal={(regionStoryId, status) =>
              emit(EVENTS.REVEAL_REGION, { regionStoryId, status })
            }
            currentStoryId={storyId}
            goToStory={(id) => api.selectStory(id)}
            viewingStoryId={scope === 'all' ? undefined : storyId}
          />
        ))
      ) : (
        <p style={{ color: theme.textMutedColor }}>
          {query.trim()
            ? `Nothing matches “${query.trim()}” in ${feedback.length} comment${feedback.length === 1 ? '' : 's'}.`
            : threadState === 'open'
              ? 'Nothing open here.'
              : threadState === 'resolved'
                ? 'Nothing resolved here.'
                : scope === 'all'
                  ? 'No feedback anywhere in this review yet.'
                  : 'No comments here yet.'}
        </p>
      )}
    </div>
  );
};

addons.register(ADDON_ID, () => {
  addons.add(PANEL_ID, {
    type: types.PANEL,
    title: 'Greenroom',
    render: ({ active }) => <Panel active={!!active} />,
  });
});
