import { defineConfig, devices } from 'playwright/test'

const mobilePort = 4173
const desktopPort = 4174

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${mobilePort}`,
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: `node ./node_modules/vite/bin/vite.js --mode mobile --host 127.0.0.1 --port ${mobilePort}`,
      url: `http://127.0.0.1:${mobilePort}`,
      reuseExistingServer: !process.env.CI,
      env: {
        VITE_HIVEKEEP_MOBILE: 'true',
      },
    },
    {
      command: `node ./node_modules/vite/bin/vite.js --mode desktop --host 127.0.0.1 --port ${desktopPort}`,
      url: `http://127.0.0.1:${desktopPort}`,
      reuseExistingServer: !process.env.CI,
      env: {
        VITE_HIVEKEEP_DESKTOP: 'true',
        VITE_HIVEKEEP_MOBILE: 'true',
      },
    },
  ],
  projects: [
    {
      name: 'mobile-chromium',
      testMatch: /mobile-smoke\.spec\.ts/,
      use: {
        ...devices['Pixel 5'],
        baseURL: `http://127.0.0.1:${mobilePort}`,
      },
    },
    {
      name: 'desktop-chromium',
      testMatch: /desktop-smoke\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${desktopPort}`,
      },
    },
  ],
})
