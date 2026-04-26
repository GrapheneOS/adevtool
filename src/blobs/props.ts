import assert from 'assert'
import path from 'path'
import { DeviceConfig } from '../config/device'
import { assertDefined, mapGet } from '../util/data'
import { isFile, readFile } from '../util/fs'
import { parseLines } from '../util/parse'
import {
  ALL_SYS_PARTITIONS,
  Partition,
  partitionRelativePath,
  PathResolver,
  PathResolverContext,
} from '../util/partitions'

export type PartitionProps = Map<string, Map<string, string>>

export interface PropChanges {
  added: Map<string, string>
  modified: Map<string, Array<string>>
  removed: Map<string, string>
}

export interface PropFilters {
  keys?: Array<string>
  prefixes?: Array<string>
}

export function parseProps(file: string) {
  let props = new Map<string, string>()
  for (let line of parseLines(file)) {
    let [key, value] = line.split('=', 2)
    if (value === undefined) {
      switch (line) {
        // a bug in sysprop files on tangorpro and felix
        case 'setprop':
          continue
        // a bug in sysprop files on rango
        case 'ro.vendor.primarydisplay.xrr.vrr.expected_present.headsup_ns':
          continue
        default:
          throw new Error('unexpected line in sysprop file: ' + line)
      }
    }
    props.set(key, value)
  }

  return props
}

export async function loadPartitionProps(
  pathResolver: PathResolver,
  config: DeviceConfig | null = null,
  isForPrepModule: boolean = false,
) {
  let partProps = new Map<string, Map<string, string>>() as PartitionProps

  for (let partition of ALL_SYS_PARTITIONS) {
    let relPath: string
    switch (partition) {
      case Partition.System:
      case Partition.Vendor:
        relPath = 'build.prop'
        break
      case Partition.Odm:
      case Partition.OdmDlkm:
      case Partition.Product:
      case Partition.SystemDlkm:
      case Partition.SystemExt:
      case Partition.VendorDlkm:
        relPath = 'etc/build.prop'
        break
      case Partition.Recovery:
        relPath = 'prop.default'
        break
      default:
        continue
    }
    let propPath = pathResolver.resolve(partition, relPath)
    if (partition === Partition.SystemDlkm && !(await isFile(propPath))) {
      continue
    }
    let props = parseProps(await readFile(propPath))
    if (
      !isForPrepModule &&
      config !== null &&
      config.device.backport_base_firmware &&
      pathResolver.context === PathResolverContext.UNPACKED_IMAGE &&
      partition === Partition.Vendor
    ) {
      let overlayPropsPath = path.join(
        assertDefined(pathResolver.overlay?.basePath, pathResolver.basePath),
        partitionRelativePath(partition, PathResolverContext.UNPACKED_IMAGE),
        'build.prop',
      )
      let overlayProps = parseProps(await readFile(overlayPropsPath))
      let overlaidProps = [BOOTLOADER_VERSION_PROP]
      if (config.device.has_cellular) {
        overlaidProps.push(BASEBAND_VERSION_PROP)
        // overlaidProps.push('ro.vendor.build.svn')
      }
      for (let prop of overlaidProps) {
        assert(props.has(prop))
        props.set(prop, mapGet(overlayProps, prop))
      }
    }
    partProps.set(partition, props)
  }

  return partProps
}

export const BOOTLOADER_VERSION_PROP = 'ro.build.expect.bootloader'
export const BASEBAND_VERSION_PROP = 'ro.build.expect.baseband'
export const MULTI_SIM_CONFIG_PROP = 'persist.radio.multisim.config'
export const BUILD_DATE_UTC_PROP = 'ro.build.date.utc'
export const BUILD_FINGERPRINT_PROP = 'ro.build.fingerprint'
export const BUILD_ID_PROP = 'ro.build.id'
export const BUILD_TAGS_PROP = 'ro.build.tags'
export const BUILD_TYPE_PROP = 'ro.build.type'
export const BUILD_VERSION_INCREMENTAL_PROP = 'ro.build.version.incremental'
export const BUILD_VERSION_RELEASE_OR_CODENAME_PROP = 'ro.build.version.release_or_codename'
export const BUILD_VERSION_SDK_PROP = 'ro.build.version.sdk'
export const BUILD_VERSION_SECURITY_PATCH_PROP = 'ro.build.version.security_patch'
export const BOOT_HARDWARE_PROP = 'ro.boot.hardware'
export const HARDWARE_PROP = 'ro.hardware'
export const INCREMENTAL_ENABLE_PROP = 'ro.incremental.enable'
export const LOW_RAM_PROP = 'ro.config.low_ram'
export const OPENGL_ES_VERSION_PROP = 'ro.opengles.version'
export const PRODUCT_CPU_ABILIST_PROP = 'ro.product.cpu.abilist'
export const PRODUCT_FIRST_API_LEVEL_PROP = 'ro.product.first_api_level'
export const SCREEN_DENSITY_PROP = 'ro.sf.lcd_density'

// Precedence for duplicate properties loaded from regular partition build.prop
// files. system/core/init/property_service.cpp#PropertyLoadBootDefaults()
// loads them from least to most product-specific, and
// system/core/init/property_service.cpp#LoadProperties() lets later duplicate
// values override earlier ones.
export const BUILD_PROP_PARTITION_PRECEDENCE: readonly Partition[] = [
  Partition.Product,
  Partition.Odm,
  Partition.Vendor,
  Partition.SystemExt,
  Partition.System,
]

// Source order used by
// system/core/init/property_service.cpp#property_initialize_ro_product_props()
// when deriving bare `ro.product.<name>` values from
// `ro.product.<source>.<name>` variants. This mirrors
// system/core/init/property_service.cpp#RO_PRODUCT_PROPS_DEFAULT_SOURCE_ORDER.
export const RO_PRODUCT_PROPS_DEFAULT_SOURCE_ORDER: readonly Partition[] = BUILD_PROP_PARTITION_PRECEDENCE

// Source order used by
// system/core/init/property_service.cpp#property_initialize_ro_cpu_abilist()'s
// kAbilistSources for deriving ro.product.cpu.abilist*.
export const RO_CPU_ABILIST_SOURCE_ORDER: readonly Partition[] = [
  Partition.Product,
  Partition.Odm,
  Partition.Vendor,
  Partition.System,
]

export function diffPartitionProps(partPropsRef: PartitionProps, partPropsNew: PartitionProps) {
  let partChanges = new Map<string, PropChanges>()
  for (let [partition, propsNew] of partPropsNew.entries()) {
    let propsRef = partPropsRef.get(partition)
    let changes = {
      added: new Map<string, string>(),
      modified: new Map<string, Array<string>>(),
      removed: new Map<string, string>(),
    } as PropChanges

    // Added, modified
    for (let [newKey, newValue] of propsNew.entries()) {
      if (propsRef?.has(newKey)) {
        let refValue = propsRef.get(newKey)!
        if (newValue != refValue) {
          changes.modified.set(newKey, [refValue, newValue])
        }
      } else {
        changes.added.set(newKey, newValue)
      }
    }

    // Removed
    if (propsRef != null) {
      for (let [refKey, refValue] of propsRef.entries()) {
        if (!propsNew.has(refKey)) {
          changes.removed.set(refKey, refValue)
        }
      }
    }

    partChanges.set(partition, changes)
  }

  return partChanges
}
