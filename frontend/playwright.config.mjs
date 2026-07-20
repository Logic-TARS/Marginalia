import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  fullyParallel: false,
  use: {
    viewport: { width: 1000, height: 700 },
  },
  webServer: {
    command: 'python -m http.server 8099',
    port: 8099,
    reuseExistingServer: true,
    cwd: '.',
  },
  projects: [
    {
      name: 'chromium-stable',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
      },
    },
  ],
});
