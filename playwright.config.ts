import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: process.env.GREENROOM_E2E_URL ?? 'http://localhost:6208',
  },
});
