import { CarrierConfig_Config } from '../proto-ts/packages/apps/CarrierConfig2/src/com/google/carrier/carrier_settings'

export interface CarrierDbOverride {
  name: string
  carrier_id: number
  mccmnc: string
  imsi_prefix_xpattern: string
  spn: string
  gid1: string
  gid2: string
}

export const CARRIER_DB_OVERRIDES: CarrierDbOverride[] = [
  // Cape (https://cape.co) - to be removed when 314560 is found in stock Pixel cfg.db
  {
    name: 'Cape',
    carrier_id: 1952, // use USCC's modem config
    mccmnc: '314560',
    imsi_prefix_xpattern: '%',
    spn: '%',
    gid1: '2273',
    gid2: '%',
  },
]

// Per-carrier CarrierSettings config overrides applied after extraction/download.
export const CARRIER_SETTINGS_PATCHES: Record<string, CarrierConfig_Config[]> = {
  cape_us: [{ key: 'carrier_volte_available_bool', boolValue: true }],
  cape_ca: [{ key: 'carrier_volte_available_bool', boolValue: true }],
}
