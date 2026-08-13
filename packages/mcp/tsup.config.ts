import { defineConfig } from 'tsup';

// Bundle the internal @greenroom/shared into the published output so the package
// has no unpublished workspace dependency. The real external deps
// (@modelcontextprotocol/sdk, zod) stay external and are installed by consumers.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: true,
  noExternal: ['@greenroom/shared'],
});
