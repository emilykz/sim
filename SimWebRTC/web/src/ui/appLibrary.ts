import type { LabApp } from './ScreenIOS'

export const APP_LIBRARY: LabApp[] = [
  {
    id: 'app-browserstack',
    name: 'BrowserStack',
    summary: 'Full-stack regression harness with snapshots.',
    releases: [
      {
        id: 'browserstack-26.04',
        label: 'v26.04',
        date: 'Apr 02, 2026',
        artifacts: [
          { id: 'bs-26-04-ios', code: '26.04.1a', platform: 'ios' },
          { id: 'bs-26-04-android', code: '26.04.1b', platform: 'android' },
          { id: 'bs-26-04-ios-b', code: '26.04.1c', platform: 'ios' },
          { id: 'bs-26-04-ios-c', code: '26.04.1d', platform: 'ios' },
          { id: 'bs-26-04-android-lite', code: '26.04.1e', platform: 'android' },
          { id: 'bs-26-04-ios-nightly', code: '26.04.1f', platform: 'ios' },
          { id: 'bs-26-04-android-nightly', code: '26.04.1g', platform: 'android' },
          { id: 'bs-26-04-ios-hotfix', code: '26.04.1h', platform: 'ios' },
          { id: 'bs-26-04-ios-regression', code: '26.04.1i', platform: 'ios' },
          { id: 'bs-26-04-ios-labs', code: '26.04.1j', platform: 'ios' },
        ],
      },
      {
        id: 'browserstack-26.02',
        label: 'v26.02',
        date: 'Feb 18, 2026',
        artifacts: [{ id: 'bs-26-02-ios', code: '26.02.1a', platform: 'ios' }],
      },
    ],
  },
  {
    id: 'app-crashprobe',
    name: 'CrashProbe',
    summary: 'Stress-test SDK integrations & crash reporting.',
    releases: [
      {
        id: 'crashprobe-26.04',
        label: 'v26.04',
        date: 'Apr 10, 2026',
        artifacts: [
          { id: 'cp-26-04-ios', code: '26.04.2a', platform: 'ios' },
          { id: 'cp-26-04-android', code: '26.04.2b', platform: 'android' },
          { id: 'cp-26-04-ios-alt', code: '26.04.2c', platform: 'ios' },
          { id: 'cp-26-04-ios-prof', code: '26.04.2d', platform: 'ios' },
          { id: 'cp-26-04-android-lite', code: '26.04.2e', platform: 'android' },
          { id: 'cp-26-04-ios-int', code: '26.04.2f', platform: 'ios' },
          { id: 'cp-26-04-ios-nightly', code: '26.04.2g', platform: 'ios' },
          { id: 'cp-26-04-ios-smoke', code: '26.04.2h', platform: 'ios' },
          { id: 'cp-26-04-ios-perf', code: '26.04.2i', platform: 'ios' },
        ],
      },
      {
        id: 'crashprobe-26.01',
        label: 'v26.01',
        date: 'Jan 29, 2026',
        artifacts: [{ id: 'cp-26-01-ios', code: '26.01.2a', platform: 'ios' }],
      },
    ],
  },
  {
    id: 'app-networklens',
    name: 'NetworkLens',
    summary: 'Live network logger with throttling presets.',
    releases: [
      {
        id: 'networklens-26.04',
        label: 'v26.04',
        date: 'Apr 05, 2026',
        artifacts: [
          { id: 'nl-26-04-ios', code: '26.04.3a', platform: 'ios' },
          { id: 'nl-26-04-macos', code: '26.04.3b', platform: 'macos' },
          { id: 'nl-26-04-ios-lite', code: '26.04.3c', platform: 'ios' },
          { id: 'nl-26-04-ios-pro', code: '26.04.3d', platform: 'ios' },
          { id: 'nl-26-04-ios-night', code: '26.04.3e', platform: 'ios' },
          { id: 'nl-26-04-ios-tools', code: '26.04.3f', platform: 'ios' },
          { id: 'nl-26-04-ios-proto', code: '26.04.3g', platform: 'ios' },
          { id: 'nl-26-04-ios-debug', code: '26.04.3h', platform: 'ios' },
          { id: 'nl-26-04-ios-sim', code: '26.04.3i', platform: 'ios' },
        ],
      },
    ],
  },
  {
    id: 'app-pixelperfect',
    name: 'PixelPerfect',
    summary: 'Visual diff + accessibility scanner.',
    releases: [
      {
        id: 'pixelperfect-26.03',
        label: 'v26.03',
        date: 'Mar 12, 2026',
        artifacts: [
          { id: 'pp-26-03-ios', code: '26.03.4a', platform: 'ios' },
          { id: 'pp-26-03-android', code: '26.03.4b', platform: 'android' },
          { id: 'pp-26-03-ios-nightly', code: '26.03.4c', platform: 'ios' },
          { id: 'pp-26-03-ios-labs', code: '26.03.4d', platform: 'ios' },
          { id: 'pp-26-03-android-lite', code: '26.03.4e', platform: 'android' },
          { id: 'pp-26-03-ios-beta', code: '26.03.4f', platform: 'ios' },
          { id: 'pp-26-03-ios-alpha', code: '26.03.4g', platform: 'ios' },
          { id: 'pp-26-03-ios-sim', code: '26.03.4h', platform: 'ios' },
          { id: 'pp-26-03-ios-hotfix', code: '26.03.4i', platform: 'ios' },
        ],
      },
      {
        id: 'pixelperfect-26.01',
        label: 'v26.01',
        artifacts: [{ id: 'pp-26-01-ios', code: '26.01.4a', platform: 'ios' }],
      },
    ],
  },
  {
    id: 'app-sandboxmail',
    name: 'Sandbox Mail',
    summary: 'Secure test inbox for deep links.',
    releases: [
      {
        id: 'sandboxmail-26.04',
        label: 'v26.04',
        artifacts: [
          { id: 'sm-26-04-ios', code: '26.04.5a', platform: 'ios' },
          { id: 'sm-26-04-web', code: '26.04.5b', platform: 'web' },
          { id: 'sm-26-04-ios-lite', code: '26.04.5c', platform: 'ios' },
          { id: 'sm-26-04-ios-sec', code: '26.04.5d', platform: 'ios' },
          { id: 'sm-26-04-ios-nightly', code: '26.04.5e', platform: 'ios' },
          { id: 'sm-26-04-ios-beta', code: '26.04.5f', platform: 'ios' },
          { id: 'sm-26-04-ios-alpha', code: '26.04.5g', platform: 'ios' },
          { id: 'sm-26-04-ios-hotfix', code: '26.04.5h', platform: 'ios' },
          { id: 'sm-26-04-ios-sim', code: '26.04.5i', platform: 'ios' },
        ],
      },
    ],
  },
]
