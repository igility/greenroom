import { defineConfig } from 'tsup';

// Storybook's manager and preview runtimes provide these modules as globals —
// they must stay external. Everything else (our deps included) gets bundled so
// the entries are self-contained browser modules.
const storybookProvided = [
  'react',
  'react-dom',
  '@storybook/icons',
  'react/jsx-runtime',
  'react-dom/client',
  /^storybook\/.*/,
];

export default defineConfig({
  entry: { manager: 'src/manager.tsx', preview: 'src/preview.ts' },
  format: ['esm'],
  platform: 'browser',
  clean: true,
  external: storybookProvided,
  noExternal: ['@igility/greenroom-shared', '@medv/finder', 'modern-screenshot'],
  esbuildOptions(options) {
    // Classic JSX transform: elements come from the Storybook-provided `react`
    // global. The automatic runtime would resolve react/jsx-runtime from the
    // workspace's React (19) while the manager renders with its own React —
    // mismatched element symbols → React error #31.
    options.jsx = 'transform';
  },
});
