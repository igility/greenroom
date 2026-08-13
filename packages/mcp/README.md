# @igility/greenroom-mcp

The MCP server for [Greenroom](https://github.com/igility/greenroom) — it gives an AI
coding agent the human review feedback on a Storybook, in a form it can act on.

Agents connect over stdio and get: `list_stories` (state `changes_requested` is the work
queue), `list_feedback` and `get_thread` (with the reviewer's pin screenshot returned as
an image), `reply_to_thread`, `mark_thread_addressed`, and `mark_story_addressed`.

Approval stays human. `approve_stories` refuses unless an admin has recorded a written
client authorization on the Greenroom server, and even then it takes an explicit confirm
step and is labeled `approved (delegated)` in the audit trail — never indistinguishable
from a human sign-off.

## Run

Point it at a running [`@igility/greenroom-server`](https://github.com/igility/greenroom) sidecar
with an agent token:

```jsonc
{
  "mcpServers": {
    "greenroom": {
      "command": "npx",
      "args": ["-y", "@igility/greenroom-mcp"],
      "env": {
        "GREENROOM_URL": "http://localhost:4788",
        "GREENROOM_TOKEN": "<agent-token>"
      }
    }
  }
}
```

## License

MIT
