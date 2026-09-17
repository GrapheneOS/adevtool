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
]
