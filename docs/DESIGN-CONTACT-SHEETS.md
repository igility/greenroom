# Design — contact sheets and tile-level review

**Status:** design agreed, not built. Supersedes an earlier draft that did not survive review.
**Date:** 2026-08-13

---

## The problem

Greenroom reviews one story at a time. That works for a component library of twenty stories
and collapses on a real one.

A production Storybook used as the reference case for this design has **746 index entries —
619 stories and 127 docs pages.** Sorted alphabetically, 471 entries stand ahead of the 275
page-layout entries that are the actual product. Variants are exposed as top-level siblings:
68 `Default`, 68 `Loading`, 54 `Error`, 26 `Empty`. A reviewer walking that sidebar looks at
68 loading spinners in a row.

Greenroom makes it worse rather than better. `parseStoryIndex` filters to `type === 'story'`
and flattens `title` and `name` into one string, and the reviewer shell groups only by
workflow state — so on a first review every entry lands in one flat list headed
**"In review (619)"**.

The answer is a **contact sheet**: one page showing a whole class of components at once, each
tile live, labelled, and addressable. Roughly 19 surfaces instead of 746 entries.

That solves navigation and creates a new problem, which is what this document is about: **when
many elements sit on one page, how does a reviewer say which one they mean — and how does that
comment get routed, tracked and resolved?**

## Non-goal: a taxonomy

Greenroom does not know what a "form element" is and must never learn. The host Storybook
declares its own classes and authors its own sheets. Greenroom's contribution is three
primitives — **tile identity, tile-scoped capture, and tile-scoped status** — which work on any
page that declares regions, contact sheet or not. A page-layout story that annotates its header
and footer gets the same behaviour for free.

The contract is one attribute:

```html
<div data-greenroom-story-id="designsystem-inputs-phonefield--default"> … </div>
```

Emit it and the tile becomes addressable. Emit nothing and everything behaves as it does today.

### Generation tooling is a separate, optional layer

Greenroom's MCP surface may grow tools that help an agent *organise* a Storybook — propose
classes, scaffold contact sheets, apply tags, derive a "used on" index. Those are worth having
and they are strictly additive.

**Nothing in the review path may depend on them.** A hand-authored Storybook that emits the
attribute must behave identically to a generated one; the core must never import from the
generator, and no review feature may assume a sheet was machine-produced. The generator's
output is one way to satisfy the contract, not the contract itself. If that boundary blurs,
Greenroom stops being a review tool that works on any Storybook and becomes a framework that
only reviews Storybooks it built — which is the opposite of the point.

---

## The reviewer's model

The whole design is subordinate to one requirement: **a reviewer should be thinking about
aesthetics, not about the reporting tool.** Everything they must learn:

> Look at the page. If something bothers you, click it and say so.
> When nothing else does, click the button at the bottom. Next page.

**One verb.** No approve / reject / skip per tile. The only per-tile act is flagging, and the
prose carries the nuance — *"too cramped"*, *"wrong blue"*, *"not my call, ask the clinician."*
Flagging means *don't approve this yet*; there is no verdict vocabulary to learn, and "I'm not
qualified to judge this" becomes expressible without a third control.

**One button doing two jobs.** *"Approve the other 27 on this page"* is simultaneously the
batch approval and the submit. Pending comments still exist — so an agent never acts
mid-review — but the reviewer never meets a concept called "submit". The count is stated in the
button itself rather than in a modal, so the disclosure is honest and costs no friction.

**Filing is invisible.** No "filed under Phone number field · move" confirmation. The reviewer
does not hold a model of our data structure. This trades a real thing: misroutes become silent
and we catch them, not the client. Both images are attached regardless — the tile render for
detail, the page shot for context — so a comparison comment survives.

**Page-level comments are a field, not a mode.** A box under the grid: *"Anything about this
page as a whole?"* *"These are all too cramped"* is the most common thing anyone says about a
grid and it previously had nowhere to live.

**No modes, no multi-select, no modifier keys.** Which also makes the tablet path work, since
everything is a tap. Text-selection capture may come later as an explicit control attached to a
selection — never as ambient arbitration of what the next click means.

**No tour/queue duality.** There is only the tour. Round two is the same pages with fewer tiles.

### Status decoration

Tiles carry their review status, painted by the addon from a status map the shell already
holds — no server work. Three rules:

1. **Only decorate when it discriminates.** Round one, nothing is approved, so every tile would
   read the same: clutter with no signal, during open-ended defect search. Round one is clean.
2. **Visual weight inverse to frequency.** One axis, not a five-state legend: *needs you* is
   visible, *settled* recedes.
3. **Invisible to the fingerprint and the screenshot.** Overlay, never inject — a badge that
   reflows the tile moves the render hash, and decorating would change the thing being measured.
   Strip before capture, as the pin overlay already is.

Decoration is what lets round two use the same interface: settled pages drop out, remaining
pages show only what moved. The review visibly shrinks each round, which is the property that
makes a client believe it converges.

---

## What this requires — findings that killed the first draft

Verified against the source. Each of these breaks the design if unaddressed.

**1 — A sheet is an ordinary `stories` row, so its status cannot be "derived, never stored".**
Sheets must be CSF stories (`zip.ts:110` drops `type !== 'story'`), so each gets a row with
`state TEXT NOT NULL DEFAULT 'in_review'` (`db.ts:22`). Consequences fire immediately: sheets
enter `BATCHABLE` (`shell.js:50`) so "approve all remaining" signs off every sheet as a review
unit, and they enter the agent's documented work queue (`list_stories({state:'changes_requested'})`,
`server.ts:176-178`) so an agent opens a contact-sheet file and edits the review instrument
instead of the product.

→ Persisted `stories.kind` set at ingest from a tag. Excluded from `batchTargets`, from
`listStories` by default, and from the MCP queue; `POST /api/stories/:id/status` returns 400.

**2 — The read path must widen in the same commit as the write path.**
The write path is already free: both clients forward the *captured* story id rather than the
selected one (`manager.tsx:243`, `shell.js:307`) and the server validates existence only
(`store.ts:290`), so tile attribution needs no protocol, API or schema change. But the shell
refetches feedback scoped to `state.currentStoryId` (`shell.js:151-155`). Route a comment to a
component and the reviewer standing on the sheet watches their own comment vanish.

→ The sheet's rail queries the member set. The composer renders the posted comment optimistically.
**No routing ships until a reviewer can post on a sheet and watch it appear there.**

**3 — Membership, not provenance.** "Where was this comment made" is not the relation anything
needs. "Which stories does this sheet survey" is, and it exists nowhere in the schema — no
parent/child, no grouping, no component identity.

→ `sheet_members(sheet_story_id, member_story_id, build_id)` first. Per build, so a member
disappearing from the codebase is expressible rather than silently dropping out of the rollup.
An open thread on a member blocks that member's approval from *any* sheet.

**4 — Per-tile fingerprints, or sheets make round two worse than no sheets at all.**
The manifest hash is whole-tree (`zip.ts:49-54`), so any fix flips *every* approved story to
`needs_reconfirm` at story granularity (`store.ts:103-112`). After the first fix cycle the
reviewer is handed ~590 individual rows — the exact list sheets exist to collapse. And
`fingerprints` is `PRIMARY KEY (story_id, build_id)`, one hash over the whole sheet root, so
every sheet reads "changed" whenever any single tile moved, destroying the triage sort too.

→ `PRIMARY KEY (story_id, build_id, region_key)`. A real migration, and the first v2 the
migrator has ever run. **Ships in the same release as sheets, not after.**

**5 — Batch approve is the most dangerous thing here, not the easiest.**
`batchApprove()` is a client-side sequential loop that breaks on first failure
(`shell.js:190-209`), and `approved → approved` is illegal (`status.ts:36`) — so a component
already approved from a prior round or appearing on a second sheet stops the loop, leaving the
page half-signed with no record of intent. At sheet altitude it also records ~130 individual
approval events under the client's name while the confirm copy promises approval of screens
"including any you haven't opened yet" and names a count of 19.

→ A real batch endpoint applying N approvals in one SQLite transaction, returning per-story
outcomes (approved / already-approved / failed-with-reason). Batch identity in the audit trail,
so an export reads "approved via the Form elements survey" rather than 30 unrelated clicks.
Confirm copy states the true blast radius in components.

**6 — Do not crop the sheet screenshot; render the tile.**
`restoreScrollPosition` defaults off and Storybook clips the story root to `max-height:100vh`,
so on a scrolled sheet the PNG is *already* a picture of the top. Cropping that yields a crisp,
authoritative image of the wrong component — worse than today's obviously-useless whole-root
shot, because a plausible wrong image defeats scrutiny.

→ `domToPng(tileElement)` directly. Fixes correctness, size, latency and the missing attachment
cap at once. Keep a reduced-scale page shot as a second attachment for comparison and
page-level comments. Portalled content (popovers, modals, listboxes rendering to `document.body`)
falls outside the tile subtree — detect it explicitly and capture a viewport region with the
thread labelled portal-captured, rather than confidently returning a picture of a closed control.

**7 — Drafts must persist server-side.** The shell holds exactly one `pendingPin`, overwritten
on the next capture (`shell.js:60,306`); draft text lives only in the DOM and every `render()`
rebuilds the rail via `innerHTML` (`shell.js:347`), firing on post, reply, resolve, status
change, and once per story inside the fingerprint sweep. A reviewer twenty tiles into a page
loses everything, silently, on a magic link with no account.

→ A `pending` thread state, excluded from every existing `state='open'` count. The
end-of-page button is the transition.

**8 — Progress counted in units the human traverses.** "12 of 19 surfaces", never
"In review (447)". A tired reviewer shown a counter in the hundreds concludes they have barely
started, and stops.

**9 — Round-ness is per-person.** Multiple stakeholders review on separate magic links; one
completing their tour must not drop another into a queue for work they have never seen.

→ `reviewer_progress(reviewer_id, story_id, build_id, seen_at)` — purely additive. Also supplies
the cheap non-committal "viewed" mark that sits between untouched and approved.

**10 — Pin sheet story ids explicitly.** Story ids derive from title + export name and change
silently on rename, and nothing in the codebase ever deletes a `stories` row. Renaming a sheet
while iterating the taxonomy strands its entire history on an unreachable row while the new
sheet looks pristine.

→ `meta.id` on every sheet, as a hard authoring rule.

---

## Rejected, with reasons — do not re-propose

- **Symmetric multi-select.** One thread is one `story_id NOT NULL`. Fanning out gives N
  independently-resolvable threads with nothing linking them; an agent satisfies three and two
  stay open forever. The sentence people actually say is *"this should match that"* — one
  thought, one resolution.
- **Three capture modes with "coarsest-unambiguous wins" arbitration.** Nothing on screen
  indicates an armed mode today, so two of three would never be discovered — and ambient page
  state (a stray trackpad text selection) silently changing what a click means is worse than
  not having the mode.
- **Confirming attribution before posting.** ~200 decisions about internal taxonomy across a
  two-hour session, on a distinction the reviewer has no basis for an opinion about. A visible
  "change" control also reads to a skeptic as the tool announcing it is unsure.
- **Per-tile approve/reject chrome.** Turns a 30-tile page into 90 interactive targets and
  visibly restores the count-of-30 the sheet existed to remove.
- **A separate round-two queue view.** Two interfaces to learn. Round two is the tour, shorter.

---

## Unmeasured, and a go/no-go

**Time-to-interactive on a sheet.** Thirty live component trees served by a sidecar doing a
synchronous file read per asset with no cache headers. The entire throughput argument assumes a
sheet is faster to consult than thirty sidebar clicks, and that is unverified. Measure against a
real build before committing to sheet size; if it exceeds ~2s, cap tiles by measured load time
rather than by taxonomy, or render tiles as captured images with live render on demand.

## Build order

1. `stories.kind` + `sheet_members` + `reviewer_progress` (additive migration v2)
2. Per-tile fingerprints (`PRIMARY KEY` change — same release, non-negotiable)
3. Tile-aware capture resolution in the addon preview; `domToPng(tile)`
4. Widened read path + optimistic composer render
5. Batch endpoint, transactional, per-story outcomes
6. Pending thread state; end-of-page button as the transition
7. Status decoration over postMessage
8. Shell: one-button page flow, progress in surfaces, in-place flags
