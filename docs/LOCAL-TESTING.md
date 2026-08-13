# Local testing — contact sheets end to end

Verified working on 2026-08-13 against `examples/demo-storybook`.

---

## Run it

```bash
cd ~/igdev/greenroom
pnpm install && pnpm -r build

# 1. Sidecar. Prints an admin key on first run; set one to keep it stable.
GREENROOM_ADMIN_KEY=dev-admin GREENROOM_DATA_DIR=./.greenroom-data \
  node packages/server/dist/cli.js serve
#   → http://localhost:4788

# 2. Build any Storybook and upload it.
cd examples/demo-storybook && npx storybook build -o /tmp/gr-demo && cd -
node packages/server/dist/cli.js upload /tmp/gr-demo \
  --url http://localhost:4788 --token dev-admin --label "round-1"

# 3. Invite a reviewer and mint a magic link — no account needed.
RID=$(curl -s -XPOST http://localhost:4788/api/reviewers \
  -H "authorization: Bearer dev-admin" -H "content-type: application/json" \
  -d '{"name":"Jordan Client","email":"jordan@example.com"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['reviewer']['id'])")
curl -s -XPOST "http://localhost:4788/api/reviewers/$RID/links" \
  -H "authorization: Bearer dev-admin" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['url'])"
```

Open the link, pick the page under **Pages to review**, hit **Add comment**, click a tile.

## What to check

| Check | Expected |
|---|---|
| Nav | "Pages to review" leads with the sheet; the component queue is below it and does not count the sheet |
| "Approve all remaining" | Excludes the sheet. Approving a sheet directly is refused with `NOT_A_REVIEW_UNIT` |
| Composer thumbnail | Shows **only the tile you clicked**, not the whole sheet |
| Comment attribution | Filed against the component, with the sheet recorded as where it was said |
| Comment visibility | Appears on the sheet *and* on the component — a comment must never vanish after posting |
| Agent payload | `importPath` is the component's CSF file, never the contact sheet's |

Inspect what actually landed:

```bash
curl -s -H "authorization: Bearer dev-admin" http://localhost:4788/api/feedback \
  | python3 -m json.tool
sqlite3 .greenroom-data/greenroom.db \
  "SELECT member_story_id, position FROM sheet_members ORDER BY position;"
sqlite3 .greenroom-data/greenroom.db \
  "SELECT region_key, substr(hash,1,10) FROM fingerprints ORDER BY region_key;"
```

## Making your own Storybook reviewable

Two strings. No Greenroom import, no dependency — see
`examples/demo-storybook/src/ContactSheet.stories.tsx` for the whole reference implementation.

```tsx
// 1. Wrap each component so it can be addressed independently.
<figure data-greenroom-story="components-button--primary">
  <Button label="Save changes" />
</figure>

// 2. Tag the page as a survey surface, and pin its id so a retitle
//    does not strand its history on a row nobody can navigate to.
const meta = {
  title: 'Review/Buttons and inputs',
  id: 'review-sheet--controls',
  tags: ['greenroom:sheet'],
};
```

The attribute value is a **story id**, which is only guaranteed stable within a single
build. Greenroom resolves it against that build's own index at upload time; a value that
resolves to nothing is dropped and reported rather than recorded as a real member, so a
stale hardcoded id shows up as a named problem instead of a confident wrong verdict.

## Built since first draft

- **Tile selection.** Clicking a tile on a review surface selects it: the click is
  intercepted on the capture phase so the live component never fires, and the rail
  filters to that tile's comments with a `Show all (N)` link back.
- **Status paint.** Tiles with open comments are outlined, via one injected stylesheet
  keyed by story id — no DOM mutation, so the render fingerprint is unaffected, and it
  is stripped during screenshot capture.
- **Authorship, time and provenance** on every thread: `Pinned comment by Brad · Aug 13,
  11:40 AM · on <surface>`.

## Known gaps — not yet built

- **Story identity across builds.** Records still hang off the story id, which Storybook
  derives from the title. A retitle orphans threads and approvals. See
  `FINDING-host-story-identity.md`; `exportName` is in the index and is the durable key —
  confirmed present on all 639 stories of a real 768-entry build. The migration harness
  no longer blocks this: function steps, foreign-key discipline and integrity gates
  landed 2026-08-13.
- **Launch baselines.** No way yet to mark "this is what shipped" and review the delta.
- **Batch approve is still a client-side loop** that stops on the first failure. Excluding
  sheets removes the failure we know about; it does not make the operation transactional.
- **Drafts are in browser memory only.** Any re-render clears typed text, and only one
  pending comment is held at a time.
- **Sheet load time is unmeasured.** Thirty live component trees per page, served with no
  cache headers. Measure before committing to sheet size.

## The panel says the wrong thing when it fails

Found connecting the panel to a deployed sidecar from a real host Storybook, 2026-08-13.
Each of these is the addon knowing exactly what went wrong and reporting something the
reader cannot act on. Between them they cost about an hour.

- **`"Failed to fetch"` on connect.** The real cause was a `connect-src 'self'` CSP on the
  host's Storybook, which no message anywhere named. Catch the TypeError and say so,
  quoting the sidecar origin to add. Storybook sets no CSP of its own — a build from
  `examples/demo-storybook` has none — so this comes from whatever the host puts in front
  of it, and every hardened Storybook will hit it.
- **A dead token strands the panel.** An expired or revoked token renders
  `"Authentication required."` forever: the connection is restored from `localStorage`
  before any request is made, so the connect form never returns. A 401 should clear the
  stored connection and fall back to the form.
- **The disconnect control is an `⏏` glyph that renders as a white box** on at least one
  platform, and is the only route back from the state above. Make it a plain "Log out"
  text link.
- **Document the host CSP requirement** wherever connecting the panel is described.
- **`cors()` runs unconfigured**, so `access-control-allow-origin` is `*` and any origin
  can call the API. Bearer auth and same-origin cookies mean it is not a live hole, but a
  configurable allowlist is the right posture for a store holding unreleased client UI.

## Selection colour — resolved

Selection is `#2563eb` (`select.ts`), flagged is `#d4802a` (`preview.ts`). They were
listed here as identical amber; they are not, and have not been for some time.
