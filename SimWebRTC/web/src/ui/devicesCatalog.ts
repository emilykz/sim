export type DeviceStatus = 'available' | 'in_use' | 'error'

export type CatalogDevice = {
  id: string
  name: string
  platform: 'ios' | 'android'
  osVersion: string
  status: DeviceStatus
}

export const catalogDevices: CatalogDevice[] = [
  { id: 'sim-ios-16-pro', name: 'Apple iPhone 16 Pro', platform: 'ios', osVersion: '18.3.1', status: 'available' },
  { id: 'sim-ios-16-pro-max', name: 'Apple iPhone 16 Pro Max', platform: 'ios', osVersion: '18.3.1', status: 'in_use' },
  { id: 'sim-android-1', name: 'Pixel 9 Pro', platform: 'android', osVersion: '14', status: 'available' },
  { id: 'sim-android-2', name: 'Samsung Galaxy Tab S10 Ultra', platform: 'android', osVersion: '14', status: 'available' },
]
