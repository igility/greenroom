# Greenroom

Per-story review and sign-off for Storybook — readable by AI coding agents over MCP.

Humans review rendered components and approve them, one story at a time. Agents read
that feedback — with the story ID, CSF file path, args, DOM selector, and a screenshot
of the exact pin — and do the work. Nothing ships until a person signs off.

**Status: pre-release.** Under active development; not yet published to npm.

## How it fits together

- **`@greenroom/addon`** — a thin Storybook addon: a Review panel in the manager and a
  pin-drop overlay on the preview canvas. Capture and display only; no state lives here.
- **`@greenroom/server`** — the sidecar: a small Node + SQLite service you deploy next to
  a static Storybook build. Holds threads, per-story status, reviewers, magic links, and
  the audit trail. Reviewers get a plain review page via magic link — no GitHub account,
  no Storybook UI.
- **`@greenroom/mcp`** — an MCP server over the store. Agents list open feedback with
  full context, reply, and mark work addressed. Approval authority stays human: agent
  approvals are off by default, and can only be enabled by an admin recording a written
  authorization. Even then, agent approvals require an explicit confirm step and are
  labeled as delegated in the audit trail — never indistinguishable from a human click.

Approvals bind to a specific build (content-manifest hash). When a new build is uploaded,
approved stories flip to "needs re-confirm" — render fingerprints sort that queue, but
never silently carry an approval forward.

## License

MIT
