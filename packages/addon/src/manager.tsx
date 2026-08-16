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
};

const STATE_COLOR: Record<StoryState, string> = {
  in_review: '#5c6470',
  changes_requested: '#d97706',
  addressed: '#2563eb',
  approved: '#16a34a',
};

/** The label is the hover tooltip, so it stays the full sentence rather than being
 *  shortened to fit a button. */
/** Below this the control row cannot hold the pill, the icon buttons and both selects
 *  on one line, so the selects move to a row of their own. Roughly the width at which
 *  Storybook's side dock sits; the bottom dock is far wider. */
const NARROW_PANEL_PX = 560;

const APPROVE = { label: 'Approve', to: 'approved' as StoryState, icon: <CheckIcon /> };
const REQUEST = {
  label: 'Request changes',
  to: 'changes_requested' as StoryState,
  icon: <EditIcon />,
};

type ActionDef = { label: string; to: StoryState; icon: React.ReactNode };

const ACTIONS: Record<StoryState, ActionDef[]> = {
  in_review: [APPROVE, REQUEST],
  changes_requested: [
    APPROVE,
    { label: 'Back to review', to: 'in_review', icon: <UndoIcon /> },
  ],
  addressed: [APPROVE, REQUEST],
  approved: [{ label: 'Reopen', to: 'in_review', icon: <UndoIcon /> }, REQUEST],
};

/**
 * What the reviewer can do, given the state AND whether the render has moved since
 * they signed off.
 *
 * An approved story that has changed needs "Approve again" — and until now nothing
 * offered it. The affordance existed, on `needs_reconfirm`, which a new build used to
 * force everything into; when that demotion was removed the state became unreachable
 * and the button went with it. The panel then told a reviewer their component had
 * changed and gave them nothing to do about it but reopen the whole thing.
 */
export function actionsFor(state: StoryState, changed: boolean): ActionDef[] {
  if (state === 'approved' && changed) {
    return [{ ...APPROVE, label: 'Approve again' }, ...ACTIONS.approved];
  }
  return ACTIONS[state];
}

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

/** Exported for tests. The addon still mounts it through `addons.add` below; nothing
 *  else should import it. */
export const Panel: React.FC<{ active: boolean }> = ({ active }) => {
  const api = useStorybookApi();
  /**
   * `parameters.greenroom` from the host's Storybook config.
   *
   * A `token` here connects the panel with no form to fill in, which is what makes a
   * developer's own `storybook dev` usable: without it the URL and an API token have to
   * be re-entered against a sidecar that is on the same machine, every time browser
   * storage is cleared.
   *
   * It is for LOCAL configuration only. Storybook compiles parameters into the manager
   * bundle, so a token set unconditionally ships to whoever can open the built
   * Storybook. Hosts must gate it on an environment variable that is absent in
   * production — see the README. The reviewer path needs no token at all: a build
   * served by the sidecar is same-origin and the session cookie authenticates it.
   */
  const param = useParameter<{ url?: string; token?: string }>(PARAM_KEY, {});
  const storyId = (api.getCurrentStoryData?.() as { id?: string } | undefined)?.id;

  // Hosted wins over anything stored: a reviewer arriving on a magic link must not
  // inherit some developer's leftover sidecar from a previous visit in this browser.
  const hosted = useMemo(hostedConn, []);
  const [conn, setConn] = useState<Conn | null>(() => hosted ?? loadConn());

  /**
   * Adopt a configured connection when there is nothing better.
   *
   * Precedence, strongest first: hosted (the reviewer's cookie), then whatever this
   * browser stored from the connect form, then configuration.
   *
   * `dismissedConfig` is what makes logging out mean something. Without it, logging out
   * clears the connection, this effect sees an empty slot on the very next render and
   * reconnects to the configured sidecar — a button that visibly does nothing. It is
   * not read from storage on purpose: a fresh tab should pick the configured sidecar
   * up again, because that is the point of configuring it.
   *
   * Applied in an effect rather than the initial state because parameters arrive with
   * the story, which is usually a render or two after the panel first mounts.
   */
  const [dismissedConfig, setDismissedConfig] = useState(false);
  useEffect(() => {
    if (hosted || conn || dismissedConfig || !param.url || !param.token) return;
    setConn({ url: param.url, token: param.token });
  }, [hosted, conn, dismissedConfig, param.url, param.token]);
  const client = useMemo(() => (conn ? new Sidecar(conn) : null), [conn]);
  const [story, setStory] = useState<(Story & { changedSinceApproval?: boolean }) | null>(null);
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [notice, setNotice] = useState('');
  /**
   * Docked to the side the panel is a narrow column and the control row cannot hold the
   * status pill, seven icon buttons and two selects on one line — the selects wrap
   * raggedly under the icons, or squeeze until their labels are unreadable. Given their
   * own row they stay full-width and legible. Along the bottom there is room for
   * everything on one line, and spending a second row there would be waste.
   *
   * Measured off the panel, not the viewport: what changes is where Storybook docked
   * this panel, which a viewport media query cannot see.
   */
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!rootEl || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      setNarrow((entry?.contentRect.width ?? 0) < NARROW_PANEL_PX);
    });
    ro.observe(rootEl);
    return () => ro.disconnect();
    // A callback ref rather than useRef: the panel returns null until it is the active
    // tab, so a ref object would still be empty when a mount-time effect ran and the
    // observer would never attach.
  }, [rootEl]);
  /** The pending "these also changed" offer. Null unless a re-confirmation just
   *  happened and something else in this build is still flagged. */
  const [batch, setBatch] = useState<{ others: Story[]; buildId: string } | null>(null);
  const [pending, setPending] = useState<CapturedPin | null>(null);
  const [comment, setComment] = useState('');
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const theme = useTheme();
  /** Story-scoped by default; 'all' surveys the whole review. */
  const [scope, setScope] = useState<'item' | 'story' | 'all'>('story');
  /**
   * Every thread in the review, regardless of what the list is scoped to.
   *
   * The tile paint is a property of the PAGE — "here is the state of everything you can
   * see" — while the list below is deliberately scoped to one story or one tile. Deriving
   * the paint from the scoped list tied the two together, so selecting a tile refetched
   * feedback for that tile alone and every other tile on the sheet lost its colour: the
   * one moment a reviewer is comparing a component against its neighbours is the moment
   * the neighbours went blank.
   */
  const [allFeedback, setAllFeedback] = useState<FeedbackItem[] | null>(null);
  const allCount = allFeedback?.length ?? null;
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
    // Every thread, not the scoped list — see `allFeedback`. Falls back to the scoped
    // list only before the first full fetch lands, so tiles are never unpainted for
    // longer than that request takes.
    for (const i of allFeedback ?? feedback) {
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
  }, [allFeedback, feedback, approved]);

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
    // Fetched regardless of scope, for two things that must not depend on it: the
    // count the scope select shows, and the status paint on the tiles.
    client
      .allFeedback()
      .then((r) => live && setAllFeedback(r.feedback))
      .catch(() => live && setAllFeedback(null));
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
      // Whether this was a re-confirmation has to be read BEFORE the call, because the
      // call is what clears the flag.
      const wasReconfirm = to === 'approved' && story?.changedSinceApproval === true;
      const r = await client.setStatus(subjectId, to, to === 'approved' ? (build?.id ?? undefined) : undefined);
      setStory(r.story);
      refresh();
      // Only ever offered off the back of a review that just happened. Showing it on
      // arrival would be a bulk-approve button, which is a different and much worse
      // thing: this asks "you looked at that one — do these too?", and the answer is
      // only meaningful because they did look.
      if (wasReconfirm && build) {
        const others = (await client.alsoChanged(subjectId)).stories;
        setBatch(others.length ? { others, buildId: build.id } : null);
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Action failed.');
    }
  };

  const runBatch = async () => {
    if (!batch) return;
    try {
      const r = await client.batchApprove(
        batch.others.map((s) => s.storyId),
        subjectId,
        batch.buildId,
      );
      setBatch(null);
      refresh();
      // Say what did not happen. A silent partial success is the failure mode here:
      // the reviewer believes they cleared the list and the leftovers are invisible.
      if (r.skipped.length) {
        setNotice(
          `Approved ${r.approved.length}. Left ${r.skipped.length} alone: ${r.skipped
            .map((s) => s.message)
            .join(' ')}`,
        );
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Batch approval failed.');
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

  /**
   * The panel's one-line account of why there is nothing to review, or null when there
   * is. Both cases mean the same thing to a reviewer — no subject is selected — so they
   * resolve to one slot rather than two branches that have to be kept looking alike.
   *
   * A contact sheet is a survey surface, not a review unit: the server refuses to
   * approve one (NOT_A_REVIEW_UNIT) because signing off a page that contains no code
   * would sign off nothing. Offering the button anyway and letting the server say no is
   * a control that exists only to fail — the guard is right, the affordance was not.
   */
  const statusMessage =
    story?.kind === 'sheet' && !selectedRegion
      ? 'Survey page — click a tile to review that component.'
      : story
        ? null
        : notice || 'Loading…';

  /* What the rail is showing. A toggle only ever announced the state you were about to
     move to, which reads as a command rather than a filter; a select states where you
     are. The first option is deliberately labelled by what the store actually returns:
     on a contact sheet that is the whole page — the sheet plus every tile on it — not
     one story.

     Defined once and placed in whichever row the panel's width calls for. Duplicating
     the markup per layout is how two filters drift into disagreeing about their own
     options. */
  const selectStyle = {
    ...inputStyle(theme),
    width: 'auto',
    padding: '5px 6px',
    font: `12px/1.2 ${theme.typography.fonts.base}`,
  };
  const filters = (
    <>
      <select
        aria-label="Which comments to show"
        value={scope}
        onChange={(e) => setScope(e.target.value as 'story' | 'all')}
        style={selectStyle}
      >
        {selectedRegion ? <option value="item">Current item</option> : null}
        <option value="story">{sheetOnScreen ? 'This page' : 'This story'}</option>
        <option value="all">{`All feedback${allCount === null ? '' : ` (${allCount})`}`}</option>
      </select>
      <select
        aria-label="Which comment states to show"
        value={threadState}
        onChange={(e) => setThreadState(e.target.value as 'open' | 'resolved' | 'any')}
        style={selectStyle}
      >
        <option value="open">Open</option>
        <option value="resolved">Resolved</option>
        <option value="any">Any state</option>
      </select>
    </>
  );

  return (
    // The panel is a fixed-height drawer (or a narrow docked column) and the thread list
    // is unbounded — surveying all feedback puts every comment in the review here. Own
    // the scroll rather than letting the content run off the bottom with no way down.
    <div
      ref={setRootEl}
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
      {/* A sentence and a row of icon buttons do not belong on the same line. Sharing
          one, the text took the width it needed and shunted the buttons after it —
          leaving the pin stranded beside the full stop and the eye alone on the next
          row, which reads as two broken rows rather than one message. Above the
          controls it is what it is: a statement about the surface, followed by the
          things you can do on it.

          Covers the empty case too — a contact sheet with no tile picked, and the
          loading/error line before a story resolves. Both are the panel saying there is
          nothing to act on, and both wrapped the same way. */}
      {statusMessage ? (
        <div
          style={{
            color: theme.textMutedColor,
            fontSize: 12,
            marginBottom: 8,
            minWidth: 0,
          }}
        >
          {statusMessage}
        </div>
      ) : null}

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
        {statusMessage ? null : story ? (
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
            {actionsFor(story.state, story.changedSinceApproval === true).map((a) => {
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
        ) : null}

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
        {narrow ? null : filters}
        {/* Nothing to log out of when the sidecar is serving this page: there is no
            stored connection, and dropping it would strand a reviewer on a connect
            form asking for a token they were never given. */}
        {hosted ? null : (
          <Action
            label="Log out of this sidecar"
            icon={<PowerIcon />}
            onClick={() => {
              localStorage.removeItem(CONN_KEY);
              setDismissedConfig(true);
              setConn(null);
            }}
          />
        )}
      </div>

      {narrow ? (
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 10,
            minWidth: 0,
            // The selects share the row rather than sitting at their content width, so
            // the longest option — "All feedback (37)" — is not the one that gets
            // truncated first in the column where space is actually short.
            alignItems: 'center',
          }}
        >
          {filters}
        </div>
      ) : null}

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

      {batch ? (
        /* Deliberately makes no causal claim. It does not say these changed BECAUSE of
           the one just reviewed — nothing here knows that. It says they were flagged in
           the same build, which is all that is true, and leaves the inference to the
           person. Naming them rather than showing a bare count is the difference
           between agreeing to something and agreeing to a number. */
        <div
          style={{
            border: `1px solid ${theme.appBorderColor}`,
            borderRadius: theme.appBorderRadius,
            padding: '10px 12px',
            marginBottom: 10,
            fontSize: 12,
            color: theme.color.defaultText,
          }}
        >
          <div style={{ marginBottom: 6 }}>
            {batch.others.length} other {batch.others.length === 1 ? 'component' : 'components'}{' '}
            also changed in this build.
          </div>
          <ul
            style={{
              margin: '0 0 8px',
              paddingLeft: 16,
              maxHeight: 132,
              overflowY: 'auto',
              color: theme.textMutedColor,
            }}
          >
            {batch.others.map((s) => (
              <li key={s.storyId}>{s.componentTitle || s.title}</li>
            ))}
          </ul>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button size="small" variant="outline" onClick={runBatch}>
              Approve {batch.others.length} without opening
            </Button>
            <Button size="small" variant="ghost" onClick={() => setBatch(null)}>
              Review separately
            </Button>
          </div>
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
