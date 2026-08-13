# Finding — host story identity survives a rename; story ids do not

**Status:** finding, not an agreed design. Companion to `DESIGN-CONTACT-SHEETS.md`, whose item 10
covers the same failure for sheets only.
**Date:** 2026-08-13

---

## What item 10 covers, and what it does not

Item 10 is right: story ids derive from title plus export name, they change silently on rename,
and nothing deletes a `stories` row, so a rename strands history on an unreachable row while the
replacement looks pristine. Its remedy — `meta.id` on every sheet, as a hard authoring rule —
works because Greenroom authors the sheets.

It does not reach the host's own component stories, and it cannot. The design's own principle is
that Greenroom must work against any Storybook, and a host that has never heard of Greenroom will
not be following an authoring rule. So every ordinary component story is bound to a key that its
own maintainers change routinely, for reasons that have nothing to do with review.

## The measurement

The reference Storybook was reorganised in one pass this week: the sidebar was regrouped, the
class taxonomy replaced, and two components renamed.

- **102 story files had their title changed.**
- **2 changed file path.**

Keyed on story id, every one of those 102 would have orphaned its threads and approvals. Keyed on
import path plus export name, two would — and both were deliberate renames, which is exactly the
case where asking "did this become that?" is the right behaviour rather than a failure.

The two are genuinely independent. In the same index, a story titled `Components/Forms/TextField`
sits at `./src/components/ui/TextField.stories.tsx`. Title expresses taxonomy and moves whenever
someone reconsiders the taxonomy. Path expresses where the code lives and moves far less often.

## Suggestion

Treat the story id as a **routing key** and `importPath` + export name as the **identity key**.

- Both are already in every Storybook's `index.json`. No host cooperation, no authoring rule, no
  new data — which is the bar the design already sets for itself.
- Durable records (threads, pins, approvals, `reviewer_progress`) hang off identity. Links and
  navigation keep using the story id.
- When an identity disappears and a new one appears in the same file, that is a rename and is
  worth surfacing as a migration prompt rather than silently orphaning.

Item 10's `meta.id` rule still stands for sheets, where Greenroom is the author and can guarantee
it. This is about everything Greenroom does not author.

## Why the timing matters

Before Greenroom binds to a project, retitling is free. Afterwards it costs review history, and
adding an identity scheme retroactively is itself an identity change — the fix becomes the thing
it protects against. Whichever key is chosen is cheapest to choose before the first build is
uploaded anywhere.
