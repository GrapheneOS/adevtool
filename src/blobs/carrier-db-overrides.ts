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
