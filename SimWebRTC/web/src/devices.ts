export const devices = [
  {
    id: 'sim-ios-16-pro',
    name: 'iPhone 16 Pro',
    platform: 'ios',
    windowMatch: 'iPhone 16 Pro',
    bezelKind: 'pro',
  },
  {
    id: 'sim-ios-16-pro-max',
    name: 'iPhone 16 Pro Max',
    platform: 'ios',
    windowMatch: 'iPhone 16 Pro Max',
    bezelKind: 'proMax',
  },
  {
    id: 'sim-android-1',
    name: 'Android Emulator #1',
    platform: 'android',
    windowMatch: 'Android Emulator',
    bezelKind: 'android',
  },
  {
    id: 'sim-android-2',
    name: 'Android Emulator #2',
    platform: 'android',
    windowMatch: 'Android Emulator',
    bezelKind: 'android',
  },
] as const
