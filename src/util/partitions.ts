import assert from 'assert'
import { promises as fs } from 'fs'
import path from 'path'
import { PartPath } from '../blobs/file-list'
import { UNPACKED_APEXES_DIR_NAME } from '../frontend/source'
import { isFile } from './fs'

export enum Partition {
  Root = 'root',
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
  VendorRamdisk = 'vendor_ramdisk',
  VendorBoot = 'vendor_boot',
  VendorKernelBoot = 'vendor_kernel_boot',
}

export interface OverlayConfig {
  basePath: string
  dirOverlays: { [part: string]: string[] }
  fileOverlays: { [part: string]: Set<string> }
  fileOverlaysByDir: { [part: string]: { [dir: string]: Set<string> } }
}

export class PathResolver {
  overlay?: OverlayConfig

  constructor(
    readonly basePath: string,
    readonly context: PathResolverContext = PathResolverContext.UNPACKED_IMAGE,
  ) {}

  isOverlaid(part: Partition, relPath: string) {
    let overlay = this.overlay
    if (overlay === undefined) {
      return false
    }

    if (overlay.fileOverlays[part]?.has(relPath)) {
      return true
    }

    for (let dirOverlay of overlay.dirOverlays[part] ?? []) {
      if (
        dirOverlay === relPath ||
        (relPath.length > dirOverlay.length && relPath[dirOverlay.length] === '/' && relPath.startsWith(dirOverlay))
      ) {
        return true
      }
    }
    return false
  }

  resolve(part: Partition, relPath: string | null = null) {
    let partPath = partitionRelativePath(part, this.context)

    if (relPath !== null) {
      let overlay = this.overlay
      if (overlay !== undefined && this.isOverlaid(part, relPath)) {
        return path.join(overlay.basePath, partPath, relPath)
      }
      return path.join(this.basePath, partPath, relPath)
    } else {
      return path.join(this.basePath, partPath)
    }
  }

  async *listRecursively(part: Partition, relPath: string | null): AsyncGenerator<PartPath> {
    let dirPath = this.resolve(part, relPath)
    let overlaidFiles = new Set<string>()
    if (this.overlay !== undefined) {
      let dirs = this.overlay.fileOverlaysByDir[part]
      if (dirs !== undefined) {
        let files = dirs[relPath !== null ? relPath : '']
        if (files !== undefined) {
          overlaidFiles = new Set(files)
        }
      }
    }
    for (let entry of await fs.readdir(dirPath, { withFileTypes: true })) {
      let entryRelPath = relPath === null ? entry.name : path.join(relPath, entry.name)
      if (entry.isDirectory()) {
        if (isInnerPartitionPath(part, entryRelPath, this.context)) {
          continue
        }
        yield* this.listRecursively(part, entryRelPath)
      } else {
        overlaidFiles.delete(entry.name)
        yield new PartPath(part, entryRelPath)
      }
    }
    for (let fileName of overlaidFiles) {
      let fileRelPath = relPath !== null ? path.join(relPath, fileName) : fileName
      let filePath = this.resolve(part, fileRelPath)
      if (await isFile(filePath)) {
        yield new PartPath(part, fileRelPath)
      }
    }
  }

  backResolve(fullPath: string): PartPath | null {
    return backResolvePath(path.relative(this.basePath, fullPath), this.context)
  }

  getUnpackedApexDir() {
    assert(this.context === PathResolverContext.UNPACKED_IMAGE)
    return path.join(this.basePath, UNPACKED_APEXES_DIR_NAME)
  }

  resolveUnpackedApexPath(part: Partition, relPath: string) {
    assert(this.context === PathResolverContext.UNPACKED_IMAGE)
    let apexPath = this.resolve(part, relPath)
    return path.join(this.basePath, UNPACKED_APEXES_DIR_NAME, path.relative(this.basePath, apexPath))
  }
}

export enum PathResolverContext {
  UNPACKED_IMAGE,
  BUILD_OUTPUT_DIR,
}

export function partitionRelativePath(
  part: Partition,
  context: PathResolverContext = PathResolverContext.UNPACKED_IMAGE,
): string {
  switch (part) {
    case Partition.Root:
      return context === PathResolverContext.UNPACKED_IMAGE ? 'system' : 'root'
    case Partition.System:
      return context === PathResolverContext.UNPACKED_IMAGE ? 'system/system' : 'system'
    case Partition.Odm:
      return 'vendor/odm'
    case Partition.OdmDlkm:
      return 'vendor/odm_dlkm'
    case Partition.Recovery:
      return context === PathResolverContext.UNPACKED_IMAGE ? 'vendor_boot/vendor_ramdisk00__unpacked' : 'recovery/root'
    case Partition.InitBoot:
      return context === PathResolverContext.UNPACKED_IMAGE ? 'init_boot/ramdisk__unpacked' : 'ramdisk'
    case Partition.VendorRamdisk:
      return context === PathResolverContext.UNPACKED_IMAGE
        ? 'vendor_boot/vendor_ramdisk00__unpacked/first_stage_ramdisk'
        : 'vendor_ramdisk/first_stage_ramdisk'
    default:
      return part
  }
}

function backResolvePath(path: string, context: PathResolverContext): PartPath | null {
  let parts = path.split('/')
  let res = partitionFromPath(parts, context)
  if (res === null) {
    return null
  }
  return new PartPath(res[0], parts.slice(res[1]).join('/'))
}

function isInnerPartitionPath(part: Partition, relPath: string, context: PathResolverContext) {
  switch (part) {
    case Partition.Root:
      if (context === PathResolverContext.UNPACKED_IMAGE) {
        return relPath === Partition.System
      }
      break
    case Partition.Vendor:
      switch (relPath) {
        case 'odm':
        case 'odm_dlkm':
          return true
      }
      break
    case Partition.Recovery:
      if (context === PathResolverContext.UNPACKED_IMAGE && relPath === 'first_stage_ramdisk') {
        return true
      }
      break
  }
  return false
}

function partitionFromPath(parts: string[], context: PathResolverContext): [Partition, number] | null {
  assert(parts.length >= 1)
  let part1 = parts[0]
  let part2 = parts.length >= 2 ? parts[1] : null
  switch (part1) {
    case Partition.Root:
      if (context === PathResolverContext.BUILD_OUTPUT_DIR) {
        return [Partition.Root, 1]
      }
      break
    case Partition.System:
      if (context === PathResolverContext.BUILD_OUTPUT_DIR) {
        return [Partition.System, 1]
      }
      if (context === PathResolverContext.UNPACKED_IMAGE) {
        if (part2 === 'system') {
          return [Partition.System, 2]
        } else {
          return [Partition.Root, 1]
        }
      }
      break
    case Partition.Vendor:
      switch (part2) {
        case 'odm':
          return [Partition.Odm, 2]
        case 'odm_dlkm':
          return [Partition.OdmDlkm, 2]
      }
      return [Partition.Vendor, 1]
    case Partition.Recovery:
      if (context === PathResolverContext.BUILD_OUTPUT_DIR && part2 === 'root') {
        return [Partition.Recovery, 2]
      }
      break
    case Partition.VendorBoot:
      if (context === PathResolverContext.UNPACKED_IMAGE && part2 === 'vendor_ramdisk00__unpacked') {
        if (parts[2] === 'first_stage_ramdisk') {
          return [Partition.VendorRamdisk, 3]
        }
        return [Partition.Recovery, 2]
      }
      break
    case Partition.SystemExt:
    case Partition.Product:
    case Partition.SystemDlkm:
    case Partition.VendorDlkm:
    case Partition.VendorKernelBoot:
      return [part1, 1]
    case Partition.InitBoot:
      if (context === PathResolverContext.UNPACKED_IMAGE && part2 === 'ramdisk__unpacked') {
        return [Partition.InitBoot, 2]
      }
      if (context === PathResolverContext.BUILD_OUTPUT_DIR) {
        return [Partition.InitBoot, 1]
      }
      break
    case 'ramdisk':
      if (context === PathResolverContext.BUILD_OUTPUT_DIR) {
        return [Partition.InitBoot, 1]
      }
      break
    case 'vendor_ramdisk':
      if (context === PathResolverContext.BUILD_OUTPUT_DIR && part2 === 'first_stage_ramdisk') {
        return [Partition.VendorRamdisk, 2]
      }
      break
  }
  return null
}

// Android system partitions, excluding "system"
export type ExtSysPartition = Partition.SystemExt | Partition.Product | Partition.Vendor | Partition.Odm
export const EXT_SYS_PARTITIONS = new Set([Partition.SystemExt, Partition.Product, Partition.Vendor, Partition.Odm])

// GKI DLKM partitions
export type DlkmPartition = Partition.SystemDlkm | Partition.VendorDlkm | Partition.OdmDlkm
export const DLKM_PARTITIONS = new Set([Partition.SystemDlkm, Partition.VendorDlkm, Partition.OdmDlkm])

export type ExtPartition = ExtSysPartition | DlkmPartition
export const EXT_PARTITIONS = new Set([
  ...EXT_SYS_PARTITIONS,
  ...DLKM_PARTITIONS,
  Partition.VendorRamdisk,
  Partition.InitBoot,
  Partition.Recovery,
])

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
  | Partition.VendorRamdisk
  | Partition.VendorKernelBoot

export const BOOT_PARTITIONS = new Set([
  Partition.Boot,
  Partition.InitBoot,
  Partition.VendorBoot,
  Partition.VendorRamdisk,
  Partition.VendorKernelBoot,
])

export enum PartitionImage {
  System = 'system',
  SystemDlkm = 'system_dlkm',
  SystemExt = 'system_ext',
  Product = 'product',
  Vendor = 'vendor',
  VendorDlkm = 'vendor_dlkm',
  Odm = 'odm',
  OdmDlkm = 'odm_dlkm',
}

export enum BootPartitionImage {
  Boot = 'boot',
  InitBoot = 'init_boot',
  VendorBoot = 'vendor_boot',
  VendorKernelBoot = 'vendor_kernel_boot',
}

export const UNPACKABLE_PARTITION_IMAGES = new Set<string>([
  ...Object.values(PartitionImage),
  ...Object.values(BootPartitionImage),
])

export const UNPACKABLE_BOOT_PARTITION_IMAGES = new Set<string>(Object.values(BootPartitionImage))
