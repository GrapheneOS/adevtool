export enum Partition {
  // System
  System = 'system',
  SystemDlkm = 'system_dlkm',
  SystemExt = 'system_ext',
  Product = 'product',
  Vendor = 'vendor',
  VendorDlkm = 'vendor_dlkm',
  Odm = 'odm',
  OdmDlkm = 'odm_dlkm',

  // Boot
  Boot = 'boot',
  Dt = 'dt',
  Dtbo = 'dtbo',
  InitBoot = 'init_boot',
  PvmFw = 'pvmfw',
  Ramdisk_16k = 'ramdisk_16k',
  Recovery = 'recovery',
  Vbmeta = 'vbmeta',
  VbmetaSystem = 'vbmeta_system',
  VbmetaVendor = 'vbmeta_vendor',
  VendorBoot = 'vendor_boot',
  VendorKernelBoot = 'vendor_kernel_boot',
}

export function partitionRelativePath(part: Partition): string {
  switch (part) {
    case Partition.System:
      return 'system/system'
    case Partition.Odm:
      return 'vendor/odm'
    case Partition.OdmDlkm:
      return 'vendor/odm_dlkm'
    default:
      return part
  }
}

// Android system partitions, excluding "system"
export type ExtSysPartition = Partition.SystemExt | Partition.Product | Partition.Vendor | Partition.Odm
export const EXT_SYS_PARTITIONS = new Set([Partition.SystemExt, Partition.Product, Partition.Vendor, Partition.Odm])

// GKI DLKM partitions
export type DlkmPartition = Partition.SystemDlkm | Partition.VendorDlkm | Partition.OdmDlkm
export const DLKM_PARTITIONS = new Set([Partition.SystemDlkm, Partition.VendorDlkm, Partition.OdmDlkm])

export type ExtPartition = ExtSysPartition | DlkmPartition
export const EXT_PARTITIONS = new Set([...EXT_SYS_PARTITIONS, ...DLKM_PARTITIONS])

// All system partitions
export type SysPartition = Partition.System | ExtPartition
export const ALL_SYS_PARTITIONS = new Set([Partition.System, ...EXT_PARTITIONS])

// All non-DLKM system partitions
export type RegularSysPartition = Partition.System | ExtSysPartition
export const REGULAR_SYS_PARTITIONS = new Set([Partition.System, ...EXT_SYS_PARTITIONS])

export type BootPartition =
  | Partition.Boot
  | Partition.Dt
  | Partition.Dtbo
  | Partition.InitBoot
  | Partition.Ramdisk_16k
  | Partition.VendorBoot
  | Partition.VendorKernelBoot

export const BOOT_PARTITIONS = new Set([
  Partition.Boot,
  Partition.InitBoot,
  Partition.VendorBoot,
  Partition.VendorKernelBoot,
])

export const ALL_KNOWN_PARTITIONS = new Set([...ALL_SYS_PARTITIONS, ...BOOT_PARTITIONS])
