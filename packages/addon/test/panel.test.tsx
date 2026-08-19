// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { Story } from '@igility/greenroom-shared';

/**
 * Panel tests.
 *
 * Every bug found on 2026-08-14 — a missing button, a message wrapping the toolbar, tile
 * paint vanishing on selection — got through a green suite and a clean typecheck, and
 * was caught by looking at the screen. None of them were logic errors the server could
 * see; all of them were the panel rendering the wrong thing. So these mount the real
 * component against a faked sidecar and assert what a reviewer would actually find.
 */

// ── the host Storybook, faked ────────────────────────────────────────────────
// Only what the panel touches. Real enough that the component is unmodified for tests;
// small enough that it does not become a second implementation to keep in step.
const storybookApi = { getCurrentStoryData: vi.fn(), selectStory: vi.fn() };
let parameters: Record<string, unknown> = {};
/** Storybook's globals, where the selected viewport lives. */
let globals: Record<string, unknown> = {};
let channelHandlers: Record<string, (...a: unknown[]) => void> = {};
const channelEmit = vi.fn();

vi.mock('storybook/manager-api', () => ({
  addons: { register: vi.fn(), add: vi.fn(), getChannel: () => ({ on: vi.fn(), emit: vi.fn() }) },
  types: { PANEL: 'panel' },
  useStorybookApi: () => storybookApi,
  useParameter: () => parameters,
  useGlobals: () => [globals, vi.fn()],
  useChannel: (handlers: Record<string, (...a: unknown[]) => void>) => {
    channelHandlers = handlers;
    return channelEmit;
  },
}));

vi.mock('storybook/theming', () => ({
  useTheme: () => ({
    color: { defaultText: '#000', warning: '#d4802a', secondary: '#2563eb' },
    textMutedColor: '#666',
    appBorderColor: '#ddd',
    appBorderRadius: 4,
    input: { background: '#fff', color: '#000' },
    typography: { fonts: { base: 'system-ui' } },
  }),
}));

vi.mock('storybook/internal/components', () => ({
  Button: ({ children, ...p }: React.ComponentProps<'button'>) => <button {...p}>{children}</button>,
  IconButton: ({ children, ...p }: React.ComponentProps<'button'>) => (
    <button {...p}>{children}</button>
  ),
  TooltipNote: ({ note }: { note: string }) => <span>{note}</span>,
  WithTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@storybook/icons', () => {
  const icon = (name: string) => () => <span data-icon={name} />;
  return {
    CheckIcon: icon('check'),
    EditIcon: icon('edit'),
    EyeCloseIcon: icon('eye-close'),
    EyeIcon: icon('eye'),
    PinAltIcon: icon('pin'),
    PowerIcon: icon('power'),
    UndoIcon: icon('undo'),
  };
});

// ── the sidecar, faked ───────────────────────────────────────────────────────
const BUILD = { id: 'build-2', label: 'v2' };
const TEXTFIELD = 'components-forms-textfield--default';

type PanelStory = Story & { changedSinceApproval?: boolean };

const storyRow = (over: Partial<PanelStory> = {}): PanelStory =>
  ({
    storyId: TEXTFIELD,
    title: 'Components/Forms/TextField / Default',
    componentTitle: 'Components/Forms/TextField',
    importPath: './src/TextField.stories.tsx',
    kind: 'story',
    state: 'in_review',
    anchorBuildId: null,
    lastSeenBuildId: BUILD.id,
    changedSinceApproval: false,
    ...over,
  }) as PanelStory;

const sidecar = {
  health: vi.fn().mockResolvedValue({ ok: true }),
  story: vi.fn(),
  stories: vi.fn(),
  allFeedback: vi.fn(),
  feedbackForStory: vi.fn(),
  latestBuild: vi.fn().mockResolvedValue({ build: BUILD }),
  setStatus: vi.fn(),
  alsoChanged: vi.fn().mockResolvedValue({ stories: [] }),
  batchApprove: vi.fn().mockResolvedValue({ approved: [], skipped: [] }),
  reply: vi.fn(),
  setThreadState: vi.fn(),
  attachmentObjectUrl: vi.fn().mockResolvedValue('blob:shot'),
  uploadScreenshot: vi.fn(),
  createThread: vi.fn(),
  reconfirmQueue: vi.fn().mockResolvedValue({ buildId: BUILD.id, items: [] }),
};

vi.mock('../src/api.js', () => ({ Sidecar: vi.fn(() => sidecar) }));

const { Panel, actionsFor } = await import('../src/manager.js');

/** Point the whole fake at one story in one state. */
function serving(story: PanelStory, rows: PanelStory[] = [story], feedback: unknown[] = []) {
  storybookApi.getCurrentStoryData.mockReturnValue({ id: story.storyId });
  sidecar.story.mockResolvedValue({ story });
  sidecar.stories.mockResolvedValue({
    stories: rows.map((s) => ({
      ...s,
      openThreads: 0,
      unresolvedThreads: 0,
      changedSinceApproval: s.changedSinceApproval ?? false,
    })),
  });
  sidecar.allFeedback.mockResolvedValue({ feedback });
  sidecar.feedbackForStory.mockResolvedValue({ feedback });
}

beforeEach(() => {
  parameters = {};
  globals = {};
  localStorage.setItem(CONN, JSON.stringify({ url: 'http://sidecar.test', token: 't' }));
  serving(storyRow());
});
const CONN = 'greenroom-conn';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

/** The status-map emissions the panel sent to the preview, newest last. */
const paint = () =>
  channelEmit.mock.calls.filter((c) => String(c[0]).endsWith('/status-map'));

describe('a changed approval can be acted on', () => {
  it('offers Approve again when the render has moved since sign-off', async () => {
    serving(storyRow({ state: 'approved', anchorBuildId: 'build-1', changedSinceApproval: true }));
    render(<Panel active />);
    // The bug this replaces: the panel said "this has changed" and offered only Reopen
    // and Request changes, so the flag pointed at a dead end.
    expect(await screen.findByLabelText('Approve again')).toBeTruthy();
    expect(screen.getByText(/changed since you approved it/i)).toBeTruthy();
  });

  it('offers no Approve again on an approved story that has not moved', async () => {
    serving(storyRow({ state: 'approved', anchorBuildId: BUILD.id, changedSinceApproval: false }));
    render(<Panel active />);
    expect(await screen.findByLabelText('Reopen')).toBeTruthy();
    expect(screen.queryByLabelText('Approve again')).toBeNull();
    expect(screen.queryByText(/changed since you approved it/i)).toBeNull();
  });

  // The same rule, without a DOM: cheap to keep exhaustive, and it is the table that
  // silently lost the button when `needs_reconfirm` became unreachable.
  it('actionsFor leads with Approve again only for approved-and-changed', () => {
    expect(actionsFor('approved', true)[0]!.label).toBe('Approve again');
    expect(actionsFor('approved', false).map((a) => a.label)).not.toContain('Approve again');
    expect(actionsFor('in_review', true).map((a) => a.label)).not.toContain('Approve again');
    expect(actionsFor('in_review', false).map((a) => a.label)).toContain('Approve');
  });
});

describe('the batch offer', () => {
  it('names the other changed components after a re-confirmation, and approves them', async () => {
    const changed = storyRow({
      state: 'approved',
      anchorBuildId: 'build-1',
      changedSinceApproval: true,
    });
    serving(changed);
    sidecar.setStatus.mockResolvedValue({
      story: { ...changed, anchorBuildId: BUILD.id, changedSinceApproval: false },
    });
    sidecar.alsoChanged.mockResolvedValue({
      stories: [
        storyRow({ storyId: 'a--x', componentTitle: 'Components/Button' }),
        storyRow({ storyId: 'b--y', componentTitle: 'Components/Badge' }),
      ],
    });
    render(<Panel active />);
    (await screen.findByLabelText('Approve again')).click();

    const offer = await screen.findByText(/2 other components also changed/i);
    const card = offer.parentElement!;
    // Named, not just counted: agreeing to a list and agreeing to a number are
    // different acts, and the audit records this as a look that did not happen.
    expect(within(card).getByText('Components/Button')).toBeTruthy();
    expect(within(card).getByText('Components/Badge')).toBeTruthy();

    within(card).getByRole('button', { name: /Approve 2 without opening/i }).click();
    await waitFor(() =>
      expect(sidecar.batchApprove).toHaveBeenCalledWith(['a--x', 'b--y'], TEXTFIELD, BUILD.id),
    );
  });

  it('says what a batch left alone rather than reporting a silent partial success', async () => {
    const changed = storyRow({
      state: 'approved',
      anchorBuildId: 'build-1',
      changedSinceApproval: true,
    });
    serving(changed);
    sidecar.setStatus.mockResolvedValue({ story: changed });
    sidecar.alsoChanged.mockResolvedValue({
      stories: [storyRow({ storyId: 'a--x', componentTitle: 'Components/Button' })],
    });
    sidecar.batchApprove.mockResolvedValue({
      approved: [],
      skipped: [{ storyId: 'a--x', reason: 'OPEN_THREADS', message: '"Button" has 1 unresolved comment.' }],
    });
    render(<Panel active />);
    (await screen.findByLabelText('Approve again')).click();
    const offer = await screen.findByText(/1 other component also changed/i);
    within(offer.parentElement!).getByRole('button', { name: /Approve 1 without opening/i }).click();

    expect(await screen.findByText(/unresolved comment/i)).toBeTruthy();
  });
});

describe('the empty state sits above the controls, not inside them', () => {
  it('puts a survey page message on its own row', async () => {
    serving(storyRow({ kind: 'sheet', title: 'Component library/Forms', state: 'in_review' }));
    render(<Panel active />);
    const message = await screen.findByText(/click a tile to review that component/i);

    // Not "does it come first" — it did that inside the row too, and an order-only
    // assertion passes against the bug. What changed is WHICH container holds it: the
    // message must sit outside the toolbar, or it takes the width it needs and shunts
    // the pin beside the full stop with the eye alone on the next line.
    const pin = screen.getByLabelText(/Comment on element/i);
    const controlRow = pin.parentElement!;
    expect(controlRow.contains(pin)).toBe(true);
    expect(controlRow.contains(message)).toBe(false);
    expect(message.compareDocumentPosition(controlRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no status pill for a sheet, which cannot be approved', async () => {
    serving(storyRow({ kind: 'sheet', state: 'in_review' }));
    render(<Panel active />);
    await screen.findByText(/click a tile to review that component/i);
    expect(screen.queryByLabelText('Approve')).toBeNull();
  });
});

describe('tile status paint', () => {
  const thread = (storyId: string, state: string) => ({
    thread: {
      id: `t-${storyId}`,
      storyId,
      seenOnStoryId: null,
      buildId: BUILD.id,
      state,
      pin: null,
      screenshotAttachmentId: null,
      createdBy: { kind: 'reviewer', name: 'Jordan' },
      createdAt: '2026-08-14T00:00:00.000Z',
    },
    story: storyRow({ storyId }),
    messages: [],
  });

  it('paints every commented tile, not only those in the scoped list', async () => {
    // The regression: the map was built from the SCOPED feedback fetch, so selecting one
    // tile refetched feedback for that tile alone and every other tile on the sheet lost
    // its colour — at exactly the moment a reviewer is comparing neighbours.
    const sheet = storyRow({ storyId: 'sheet--all', kind: 'sheet' });
    serving(sheet, [sheet], []);
    sidecar.allFeedback.mockResolvedValue({
      feedback: [thread('a--x', 'open'), thread('b--y', 'resolved')],
    });
    sidecar.feedbackForStory.mockResolvedValue({ feedback: [] }); // scope says nothing here

    render(<Panel active />);
    // Wait on the settled map, not merely on a first emission: the panel paints once on
    // mount before any fetch resolves, and asserting against that would pass whatever
    // the fetch later produced.
    const latest = () =>
      (paint().at(-1)?.[1] ?? { statuses: {} }) as {
        statuses: Record<string, { flagged?: boolean; resolved?: boolean }>;
      };
    await waitFor(() => expect(latest().statuses['a--x']).toMatchObject({ flagged: true }));
    expect(latest().statuses['b--y']).toMatchObject({ resolved: true });
  });
});
