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
  `FINDING-host-story-identity.md`; `exportName` is in the index and is the durable key.
  The migration harness has to change first — it is SQL-only, and table rebuilds need
  `foreign_keys=OFF` issued outside the transaction.
- **Launch baselines.** No way yet to mark "this is what shipped" and review the delta.
- **Batch approve is still a client-side loop** that stops on the first failure. Excluding
  sheets removes the failure we know about; it does not make the operation transactional.
- **Drafts are in browser memory only.** Any re-render clears typed text, and only one
  pending comment is held at a time.
- **Selection and "flagged" look identical** — both amber. Selection needs its own
  colour so "what I'm looking at" and "what has a problem" are not the same signal.
- **Sheet load time is unmeasured.** Thirty live component trees per page, served with no
  cache headers. Measure before committing to sheet size.
