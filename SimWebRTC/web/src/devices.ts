export const devices = [
  {
    id: 'sim-ios-16-pro',
    name: 'iOS Simulator #1',
    platform: 'ios',
    windowMatch: 'iPhone 16 Pro',
    bezelKind: 'pro',
  },
  {
    id: 'sim-ios-16-pro-max',
    name: 'iOS Simulator #2',
    platform: 'ios',
    windowMatch: 'iPhone 16 Pro Max',
    bezelKind: 'proMax',
  },
  {
    id: 'sim-android-36',
    name: 'Android Emulator #1',
    platform: 'android',
    windowMatch: 'Android Emulator',
    bezelKind: 'android',
  },
] as const
