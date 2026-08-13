# @igility/greenroom-addon

The Storybook addon for [Greenroom](https://github.com/igility/greenroom) — per-story
review and sign-off, readable by AI coding agents over MCP.

A thin addon: it adds a **Review** panel to the Storybook manager and a **pin-drop
overlay** on the preview canvas. A reviewer clicks the exact element they mean; the addon
captures the story ID, CSF file path, args, a CSS selector, and a screenshot, and sends it
to the Greenroom sidecar. No review state lives in the addon.

Requires the [`@igility/greenroom-server`](https://github.com/igility/greenroom) sidecar and works
with the [`@igility/greenroom-mcp`](https://www.npmjs.com/package/@igility/greenroom-mcp) server so agents
can read the feedback and close the loop.

## Install

```bash
pnpm add -D @igility/greenroom-addon
```

```ts
// .storybook/main.ts
export default {
  addons: ['@igility/greenroom-addon'],
};
```

Peer dependency: Storybook `^10`.

## License

MIT
