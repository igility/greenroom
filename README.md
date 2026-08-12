# Greenroom

Per-story review and sign-off for Storybook — readable by AI coding agents over MCP.

Humans review rendered components and approve them, one story at a time. Agents read
that feedback — the story ID, CSF file path, args, DOM selector, and a screenshot of the
exact pin — and do the work. Nothing ships until a person signs off.

**Status: pre-release.** Under active development; not yet published to npm.

## How it fits together

- **`@greenroom/addon`** — a thin Storybook addon: a Review panel in the manager and a
  pin-drop overlay on the preview canvas. Capture and display only; no state lives here.
- **`@greenroom/server`** — the sidecar: a small Node + SQLite service you deploy next to
  a static Storybook build. Holds threads, per-story status, reviewers, magic links, and
  the audit trail. Reviewers get a plain review page via magic link — no GitHub account,
  no Storybook UI.
- **`@greenroom/mcp`** — an MCP server over the store. Agents list open feedback with
  full context, reply, and mark work addressed.

Approvals bind to a specific build (content-manifest hash). When a new build is uploaded,
approved stories flip to "needs re-confirm" — render fingerprints sort that queue, but
never silently carry an approval forward.

## Who can approve

Approval is a human sign-off. Reviewers open a magic link — no account — and approve per
story or in a confirmed batch. An `approver`-role reviewer can sign off; a `reviewer`-role
one can only comment.

Agents cannot approve on their own. An admin may record a written client authorization (a
**delegation**); only then can the MCP `approve_stories` tool approve — and it still
requires an explicit confirm step and is labeled `approved (delegated)`, with the
authorization, in the audit trail. It is never indistinguishable from a human click.

## Quickstart (local)

```bash
pnpm install
pnpm -r build

# 1. Run the sidecar. It prints a generated admin key on first run;
#    set GREENROOM_ADMIN_KEY to keep it stable.
GREENROOM_ADMIN_KEY=dev-admin GREENROOM_DATA_DIR=./.greenroom-data \
  node packages/server/dist/cli.js serve
#   → http://localhost:4788

# 2. Build a Storybook and upload it (any static Storybook works).
pnpm build:demo   # builds examples/demo-storybook/storybook-static
node packages/server/dist/cli.js upload examples/demo-storybook/storybook-static \
  --url http://localhost:4788 --token dev-admin --label "design-round-1"

# 3. Invite a reviewer and mint a magic link (no account needed).
curl -s -XPOST http://localhost:4788/api/reviewers \
  -H "authorization: Bearer dev-admin" -H "content-type: application/json" \
  -d '{"name":"Jordan Client","email":"jordan@example.com"}'
curl -s -XPOST http://localhost:4788/api/reviewers/<reviewer-id>/links \
  -H "authorization: Bearer dev-admin"
#   → open the returned url; review, comment, approve.
```

### Connect an AI agent (MCP)

Mint an agent token and point the MCP server at the sidecar:

```bash
curl -s -XPOST http://localhost:4788/api/tokens \
  -H "authorization: Bearer dev-admin" -H "content-type: application/json" \
  -d '{"kind":"agent","name":"claude"}'
```

```jsonc
// e.g. an MCP client config
{
  "mcpServers": {
    "greenroom": {
      "command": "node",
      "args": ["packages/mcp/dist/index.js"],
      "env": { "GREENROOM_URL": "http://localhost:4788", "GREENROOM_TOKEN": "<agent-token>" }
    }
  }
}
```

The agent then sees `list_stories` (state `changes_requested` is its work queue),
`list_feedback`/`get_thread` (with the pin screenshot as an image), `reply_to_thread`,
`mark_story_addressed`, and the delegation-gated `approve_stories`.

### Add the addon to a Storybook (optional, for in-Storybook review)

```ts
// .storybook/main.ts
export default { addons: ['@greenroom/addon'] };
```

## Deploy the sidecar

```bash
docker build -t greenroom .
docker run -p 4788:4788 -v greenroom-data:/data \
  -e GREENROOM_ADMIN_KEY=$(openssl rand -base64 24) \
  -e GREENROOM_PUBLIC_URL=https://review.example.com \
  greenroom
```

All state lives under `GREENROOM_DATA_DIR` (default `/data` in the image): the SQLite
database, the extracted builds, and pin screenshots. Back it up by copying that one
directory. No external services.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `GREENROOM_PORT` | `4788` | Listen port |
| `GREENROOM_DATA_DIR` | `.greenroom-data` | SQLite + builds + attachments |
| `GREENROOM_ADMIN_KEY` | generated | Admin bearer token (set to keep stable) |
| `GREENROOM_PUBLIC_URL` | `http://localhost:<port>` | Base for magic-link URLs; `https://` enables the Secure cookie flag |
| `GREENROOM_MAX_UPLOAD_BYTES` | `250MB` | Reject larger build uploads |

## Development

```bash
pnpm -r typecheck
pnpm -r test          # unit / integration (shared, server, mcp)
pnpm build:demo       # build the demo Storybook the e2e suite serves
npx playwright test   # end-to-end (spawns its own sidecars + static servers)
```

## License

MIT
