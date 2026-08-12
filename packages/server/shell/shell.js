/* Greenroom reviewer shell — dependency-free ES module.
 * Everything talks to the same-origin sidecar with the reviewer's cookie.
 * The story renders in the uploaded build's own iframe; pin capture runs
 * inside it (the Greenroom addon's preview code) over postMessage.
 *
 * Rendering is regioned: the skeleton (including the story iframe) is built
 * once and never rebuilt — an iframe recreated or moved by innerHTML reloads
 * and drops pin-mode state mid-capture. Only its src changes, and only when
 * the selected story changes. */

const STATE_LABEL = {
  in_review: 'In review',
  changes_requested: 'Changes requested',
  addressed: 'Addressed',
  approved: 'Approved',
  needs_reconfirm: 'Re-confirm',
};

const GROUPS = [
  ['needs_reconfirm', 'Needs re-confirmation'],
  ['changes_requested', 'Changes requested'],
  ['addressed', 'Addressed — pending re-review'],
  ['in_review', 'In review'],
  ['approved', 'Approved'],
];

const ACTIONS = {
  in_review: [
    { label: 'Approve', to: 'approved', kind: 'approve' },
    { label: 'Request changes', to: 'changes_requested' },
  ],
  changes_requested: [
    { label: 'Approve', to: 'approved', kind: 'approve' },
    { label: 'Back to review', to: 'in_review' },
  ],
  addressed: [
    { label: 'Approve', to: 'approved', kind: 'approve' },
    { label: 'Request changes', to: 'changes_requested' },
  ],
  approved: [
    { label: 'Reopen', to: 'in_review' },
    { label: 'Request changes', to: 'changes_requested' },
  ],
  needs_reconfirm: [
    { label: 'Approve again', to: 'approved', kind: 'approve' },
    { label: 'Request changes', to: 'changes_requested' },
  ],
};

const BATCHABLE = ['in_review', 'addressed', 'needs_reconfirm'];

const state = {
  me: null,
  build: null,
  stories: [],
  verdicts: {}, // storyId -> fingerprint verdict for the current build
  currentStoryId: null,
  feedback: [],
  pendingPin: null,
  notice: '',
  confirmBatch: false,
  sweep: null, // { done, total } while scanning
  sentFingerprints: new Set(),
};

const app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

async function api(method, path, body, contentType) {
  const res = await fetch(path, {
    method,
    headers:
      body !== undefined && !contentType
        ? { 'content-type': 'application/json' }
        : contentType
          ? { 'content-type': contentType }
          : {},
    body: body === undefined ? undefined : contentType ? body : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `${method} ${path} failed`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ── skeleton (built once) ────────────────────────────────────────────────────

let regions = null;

function buildSkeleton() {
  app.innerHTML = `
    <header>
      <h1>Greenroom</h1>
      <span class="who" id="who"></span>
      <span class="spacer"></span>
      <span id="header-actions"></span>
    </header>
    <div id="confirm-region"></div>
    <div class="layout">
      <nav id="story-list"></nav>
      <main>
        <div class="canvas" id="canvas">
          <p class="gate" id="canvas-empty">Pick a screen on the left to review it.</p>
        </div>
        <aside id="rail"></aside>
      </main>
    </div>`;
  const frame = document.createElement('iframe');
  frame.id = 'frame';
  frame.title = 'Story preview';
  frame.style.display = 'none';
  document.getElementById('canvas').appendChild(frame);
  regions = {
    who: document.getElementById('who'),
    headerActions: document.getElementById('header-actions'),
    confirm: document.getElementById('confirm-region'),
    nav: document.getElementById('story-list'),
    rail: document.getElementById('rail'),
    frame,
    canvasEmpty: document.getElementById('canvas-empty'),
  };
}

// ── data loading ─────────────────────────────────────────────────────────────

async function loadAll() {
  const [storiesRes, queueRes] = await Promise.all([
    api('GET', '/api/stories'),
    state.build ? api('GET', `/api/reconfirm-queue?buildId=${state.build.id}`).catch(() => null) : null,
  ]);
  state.stories = storiesRes.stories;
  state.verdicts = {};
  for (const item of queueRes?.items ?? []) state.verdicts[item.story.storyId] = item.verdict;
}

async function loadFeedback() {
  if (!state.currentStoryId) return;
  const res = await api('GET', `/api/feedback?storyId=${encodeURIComponent(state.currentStoryId)}`);
  state.feedback = res.feedback;
}

// ── actions ──────────────────────────────────────────────────────────────────

async function selectStory(storyId) {
  state.currentStoryId = storyId;
  state.pendingPin = null;
  state.notice = '';
  await loadFeedback();
  render();
}

async function setStatus(storyId, to) {
  try {
    await api('POST', `/api/stories/${encodeURIComponent(storyId)}/status`, {
      to,
      buildId: to === 'approved' ? state.build.id : undefined,
    });
    await loadAll();
    await loadFeedback();
  } catch (e) {
    state.notice = e.message;
  }
  render();
}

async function batchApprove() {
  const targets = state.stories.filter((s) => BATCHABLE.includes(s.state));
  state.confirmBatch = false;
  for (const s of targets) {
    try {
      await api('POST', `/api/stories/${encodeURIComponent(s.storyId)}/status`, {
        to: 'approved',
        buildId: state.build.id,
      });
    } catch (e) {
      state.notice = `Stopped at ${s.storyId}: ${e.message}`;
      break;
    }
  }
  await loadAll();
  await loadFeedback();
  render();
}

function enterPinMode() {
  regions.frame.contentWindow?.postMessage({ type: 'greenroom:enter-pin-mode' }, '*');
}

async function postComment(text) {
  const pending = state.pendingPin;
  if (!pending || !text.trim()) return;
  try {
    let screenshotAttachmentId;
    if (pending.screenshotDataUrl) {
      const [meta, b64] = pending.screenshotDataUrl.split(',');
      const type = (meta.match(/data:([^;]+)/) || [])[1] || 'image/png';
      const bytes = Uint8Array.from(atob(b64 || ''), (ch) => ch.charCodeAt(0));
      const up = await api('POST', '/api/attachments', bytes, type);
      screenshotAttachmentId = up.attachmentId;
    }
    await api('POST', '/api/threads', {
      storyId: pending.storyId,
      buildId: state.build.id,
      body: text.trim(),
      pin: pending.pin,
      args: pending.args,
      screenshotAttachmentId,
    });
    state.pendingPin = null;
    await loadAll();
    await loadFeedback();
  } catch (e) {
    state.notice = e.message;
  }
  render();
}

async function reply(threadId, text) {
  if (!text.trim()) return;
  await api('POST', `/api/threads/${threadId}/messages`, { body: text.trim() });
  await loadFeedback();
  render();
}

async function resolveThread(threadId) {
  await api('POST', `/api/threads/${threadId}/state`, { state: 'resolved' });
  await loadFeedback();
  render();
}

/** Fingerprint every story of the current build in a hidden iframe so the
 * re-confirm queue can be sorted without visiting each story by hand. */
async function sweep() {
  const stories = state.stories;
  state.sweep = { done: 0, total: stories.length };
  render();
  const hidden = document.createElement('iframe');
  hidden.style.cssText = 'position:absolute;left:-10000px;width:1000px;height:700px;';
  document.body.appendChild(hidden);
  for (const s of stories) {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 6000);
      const onMsg = (e) => {
        if (e.data?.type === 'greenroom:fingerprint' && e.data.storyId === s.storyId) {
          window.removeEventListener('message', onMsg);
          clearTimeout(timeout);
          resolve();
        }
      };
      window.addEventListener('message', onMsg);
      hidden.src = `/builds/${state.build.id}/iframe.html?id=${encodeURIComponent(s.storyId)}&viewMode=story`;
    });
    state.sweep.done++;
    render();
  }
  hidden.remove();
  state.sweep = null;
  await loadAll();
  render();
}

// Fingerprints arrive from any build iframe (visible story or sweep) — store
// them keyed to the current build; duplicates are skipped.
window.addEventListener('message', (e) => {
  const data = e.data;
  if (!data || !state.build) return;
  if (data.type === 'greenroom:fingerprint' && data.storyId && data.hash) {
    const key = `${data.storyId}:${state.build.id}`;
    if (state.sentFingerprints.has(key)) return;
    state.sentFingerprints.add(key);
    api('PUT', '/api/fingerprints', {
      storyId: data.storyId,
      buildId: state.build.id,
      hash: data.hash,
    }).catch(() => state.sentFingerprints.delete(key));
  } else if (data.type === 'greenroom:pin-captured' && data.captured) {
    state.pendingPin = data.captured;
    render();
  }
});

// ── rendering (regioned; the iframe is never rebuilt) ────────────────────────

function render() {
  const { me, build } = state;
  if (!me) return;
  if (!build) {
    app.innerHTML = `<div class="gate"><h1>Greenroom</h1><p>No build has been uploaded for review yet.</p></div>`;
    return;
  }

  const current = state.stories.find((s) => s.storyId === state.currentStoryId) ?? null;
  const batchable = state.stories.filter((s) => BATCHABLE.includes(s.state));

  regions.who.innerHTML = `Reviewing <strong>${esc(build.label)}</strong> · signed in as ${esc(me.name)}`;

  regions.headerActions.innerHTML = `
    ${state.sweep ? `<span class="sweep-status">Scanning for changes… ${state.sweep.done}/${state.sweep.total}</span>` : `<button class="action" id="sweep-btn">Scan for changes</button>`}
    ${batchable.length ? `<button class="action approve" id="batch-btn">Approve all remaining (${batchable.length})</button>` : ''}`;

  regions.confirm.innerHTML = state.confirmBatch
    ? confirmStripHtml(batchable.length, build.label)
    : '';

  regions.nav.innerHTML = navHtml();
  regions.rail.innerHTML = current ? railHtml(current) : '';

  if (current) {
    regions.canvasEmpty.style.display = 'none';
    regions.frame.style.display = '';
    const src = `/builds/${build.id}/iframe.html?id=${encodeURIComponent(current.storyId)}&viewMode=story`;
    if (regions.frame.getAttribute('src') !== src) regions.frame.setAttribute('src', src);
  } else {
    regions.canvasEmpty.style.display = '';
    regions.frame.style.display = 'none';
  }

  wireEvents(current);
}

function confirmStripHtml(count, label) {
  return `
    <div class="confirm-strip">
      You're about to approve <strong>${count}</strong> screen${count === 1 ? '' : 's'} against build
      "<strong>${esc(label)}</strong>" — every remaining screen except those with changes requested.
      Each approval is recorded in the audit trail under your name.
      <div class="buttons">
        <button class="action approve" id="batch-confirm">Approve ${count} screen${count === 1 ? '' : 's'}</button>
        <button class="action" id="batch-cancel">Cancel</button>
      </div>
    </div>`;
}

function navHtml() {
  return GROUPS.map(([key, title]) => {
    let group = state.stories.filter((s) => s.state === key);
    if (!group.length) return '';
    if (key === 'needs_reconfirm') {
      const rank = { changed: 0, unknown: 1, likely_unchanged: 2 };
      group = [...group].sort(
        (a, b) => (rank[state.verdicts[a.storyId]] ?? 1) - (rank[state.verdicts[b.storyId]] ?? 1),
      );
    }
    const rows = group
      .map((s) => {
        const verdict = key === 'needs_reconfirm' ? state.verdicts[s.storyId] : null;
        return `
          <button class="story ${s.storyId === state.currentStoryId ? 'current' : ''}" data-story="${esc(s.storyId)}">
            <span class="name">${esc(s.title)}</span>
            ${verdict ? `<span class="verdict ${verdict}">${verdict === 'likely_unchanged' ? 'likely unchanged' : verdict}</span>` : ''}
            ${s.openThreads ? `<span class="bubble">💬 ${s.openThreads}</span>` : ''}
          </button>`;
      })
      .join('');
    return `<h2>${title} (${group.length})</h2>${rows}`;
  }).join('');
}

function railHtml(story) {
  const actions = (ACTIONS[story.state] || [])
    .map(
      (a) =>
        `<button class="action ${a.kind === 'approve' ? 'approve' : ''}" data-status="${a.to}">${a.label}</button>`,
    )
    .join('');

  const composer = state.pendingPin
    ? `
      <div class="composer">
        <p style="margin:0 0 6px"><strong>New comment on</strong> <code>${esc(state.pendingPin.pin.selector)}</code></p>
        ${state.pendingPin.screenshotDataUrl ? `<img src="${state.pendingPin.screenshotDataUrl}" alt="Captured screen state" />` : ''}
        <textarea id="composer-text" rows="3" placeholder="What should change?"></textarea>
        <div class="buttons">
          <button class="action primary" id="composer-post">Post comment</button>
          <button class="action" id="composer-discard">Discard</button>
        </div>
      </div>`
    : '';

  const threads = state.feedback.length
    ? state.feedback.map(threadHtml).join('')
    : '<p class="hint">No comments on this screen yet.</p>';

  return `
    <div><span class="chip ${story.state}">${STATE_LABEL[story.state]}</span></div>
    <div class="rail-actions">
      ${actions}
      <button class="action" id="pin-btn">📌 Add comment</button>
    </div>
    ${state.notice ? `<p class="notice">${esc(state.notice)}</p>` : ''}
    ${composer}
    ${threads}`;
}

function threadHtml(item) {
  const t = item.thread;
  const messages = item.messages
    .map(
      (m) =>
        `<p><strong class="${m.author.kind === 'agent' ? 'agent' : ''}">${esc(m.author.name)}${m.author.kind === 'agent' ? ' (agent)' : ''}:</strong> ${esc(m.body)}</p>`,
    )
    .join('');
  return `
    <div class="thread" data-thread="${t.id}">
      <div class="meta">
        <span>${t.pin ? `<code>${esc(t.pin.selector)}</code>` : 'General'}</span>
        <span>${t.state}</span>
      </div>
      ${t.screenshotAttachmentId ? `<img src="/api/attachments/${t.screenshotAttachmentId}" alt="Comment screenshot" loading="lazy" />` : ''}
      ${messages}
      <div class="reply-row">
        <input type="text" placeholder="Reply…" data-reply-input />
        <button class="action" data-reply>Send</button>
        ${t.state !== 'resolved' ? '<button class="action" data-resolve>Resolve</button>' : ''}
      </div>
    </div>`;
}

function wireEvents(current) {
  document.getElementById('sweep-btn')?.addEventListener('click', sweep);
  document.getElementById('batch-btn')?.addEventListener('click', () => {
    state.confirmBatch = true;
    render();
  });
  document.getElementById('batch-confirm')?.addEventListener('click', batchApprove);
  document.getElementById('batch-cancel')?.addEventListener('click', () => {
    state.confirmBatch = false;
    render();
  });

  regions.nav.querySelectorAll('.story').forEach((el) =>
    el.addEventListener('click', () => selectStory(el.dataset.story)),
  );

  if (!current) return;

  regions.rail.querySelectorAll('[data-status]').forEach((el) =>
    el.addEventListener('click', () => setStatus(current.storyId, el.dataset.status)),
  );
  document.getElementById('pin-btn')?.addEventListener('click', enterPinMode);
  document.getElementById('composer-post')?.addEventListener('click', () =>
    postComment(document.getElementById('composer-text')?.value ?? ''),
  );
  document.getElementById('composer-discard')?.addEventListener('click', () => {
    state.pendingPin = null;
    render();
  });

  regions.rail.querySelectorAll('.thread').forEach((el) => {
    const threadId = el.dataset.thread;
    const input = el.querySelector('[data-reply-input]');
    el.querySelector('[data-reply]')?.addEventListener('click', () => reply(threadId, input?.value ?? ''));
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') reply(threadId, input.value);
    });
    el.querySelector('[data-resolve]')?.addEventListener('click', () => resolveThread(threadId));
  });
}

// ── boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    const me = await api('GET', '/api/me');
    state.me = me.principal;
  } catch {
    app.innerHTML = `<div class="gate"><h1>Greenroom</h1><p>This page needs a review link. Ask your contact for a fresh one.</p></div>`;
    return;
  }
  const latest = await api('GET', '/api/builds/latest');
  state.build = latest.build;
  if (!state.build) {
    render();
    return;
  }
  buildSkeleton();
  await loadAll();
  const first =
    state.stories.find((s) => s.state === 'needs_reconfirm') ??
    state.stories.find((s) => s.state !== 'approved') ??
    state.stories[0];
  if (first) {
    state.currentStoryId = first.storyId;
    await loadFeedback();
  }
  render();
}

boot();
