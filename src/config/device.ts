// Breaks build with import, needed for structuredClone definition
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
///<reference path="../util/jstypes.d.ts" />

import { Flags } from '@oclif/core'
import assert from 'assert'
import path from 'path'

import { ApkProcessorResult } from '../processor/apk-processor'
import { DisassembledSepolicy } from '../processor/sepolicy'
import { loadAndMergeConfig } from './config-loader'
import { FilterMode, Filters, SerializedFilters } from './filters'
import { DEVICE_CONFIG_DIR } from './paths'

export enum ConfigType {
  Device = 'device',
  DeviceList = 'device-list',
}

export enum FsType {
  EXT4 = 'ext4',
  EROFS = 'erofs',
}

export interface DisplaySize {
  width: number
  height: number
}

export interface DeviceConfig {
  // Required
  device: {
    name: string
    platform: string
    vendor: string
    // file system type of OS partitions
    system_fs_type: FsType
    build_id: string
    is_beta_build_id: boolean
    backport_build_id: string | undefined
    is_beta_backport_build_id: boolean
    backport_base_firmware?: boolean
    prev_build_id: string
    has_cellular: boolean
    // ignored when undefined
    platform_security_patch_level_override?: string
    odm_skus: string[]
    // This information is required to make a GMS checkin. For some devices, these values are only
    // in the kernel / online specs, so not easily parsable from unpacked factory image.
    // stable_display_size is the value returned by DisplayManager.getStableDisplaySize().
    // DisplayManagerService.loadStableDisplayValuesLocked() loads it from persisted state or the
    // framework stable-display resource defaults. GmsCore derives smallest_screen_width_dp and
    // screen_layout_legacy from Resources.Configuration rather than this API. For foldables, use
    // the unfolded/stable display size here; folded checkin captures can differ because
    // Resources.Configuration reports the current folded display.
    stable_display_size?: DisplaySize
    gservices_flags: Filters
  }

  platform: {
    namespaces: string[]
    extra_product_makefiles: string[]
  }

  // Not part of the final config
  // includes: string[]

  synthetic_overlays: { [moduleName: string]: SyntheticOverlaySpec }

  filters: {
    overlay_keys: Filters
    overlay_inclusions: Filters
    overlay_files: Filters
    partitions: Filters
    file_exclusions: Filters
    file_inclusions: Filters
  }

  package_exclusions: string[]

  vintf_exclusions: string[]
  vintf_inclusions: string[]

  vintf_manifest_inclusions: { [part: string]: string[] }
  vintf_manifest_exclusions: { [part: string]: string[] }
  vintf_compat_matrix_inclusions: { [part: string]: string[] }
  vintf_compat_matrix_exclusions: { [part: string]: string[] }

  sepolicy_exclusions: { [part: string]: Sepolicy }
  sepolicy_inclusions: { [part: string]: Sepolicy }

  sysprop_exclusions: string[]
  sysprop_inclusions: string[]

  sysconfig_exclusions: string[]
  sysconfig_inclusions: string[]

  kernel_cmdline_exclusions: string[]
  kernel_cmdline_inclusions: string[]

  replacement_module_exclusions: string[]
  replacement_module_inclusions: string[]

  package_inclusions: { [pkgName: string]: PackageInclusionConfig }
  // Packages that are excluded from the system image, but are allowed to be installed manually.
  // Certificate digest will be checked agains the system image version before installation.
  installable_packages: string[]

  backport_dirs: { [part: string]: string[] }
  backport_files: { [part: string]: string[] }

  // Additional AOSP packages to include in PRODUCT_PACKAGES.
  extra_packages: string[]

  apk_map: { [apk_path: string]: ApkMapping }
  apex_map: { [apex_path: string]: ApexMapping }
  unique_base_apks: string[]
  unique_base_apexes: string[]
}

export interface ApkMapping {
  stock_os_path: string
  alt_stock_os_paths?: string[]
  aosp_apk_name: string
}

export interface ApexMapping {
  stock_os_path: string
  stock_to_aosp_apk_name_mapping: { [stock_apk_name: string]: string }
}

export function getExcludedPackages(config: DeviceConfig) {
  return new Set(config.package_exclusions.concat(config.installable_packages))
}

export function getExcludedPackagesMinusBasePackages(config: DeviceConfig, apkProcessorResult: ApkProcessorResult) {
  let res = new Set(config.package_exclusions.concat(config.installable_packages))
  let presentBasePackages = apkProcessorResult.presentBasePackages
  for (let pkg of presentBasePackages) {
    res.delete(pkg)
  }
  return res
}

export interface Sepolicy {
  contexts: { [fileName: string]: string[] }
  mac_permissions_entries: string[]
  types: { [name: string]: string[] } // type name -> type attributes
  typeAttrNames: string[]
  cil: string[]
  recoveryOnlyPolicy: string[]
  disassembled: DisassembledSepolicy
}

// synthetic overlay is created by copying resources from a regular (non-overlay) package
interface SyntheticOverlaySpec {
  // Only the first available path will be used. This behavior was added to support packages that
  // are stored under different paths across devices
  sourcePaths: string[]
  moduleName: string
  targetPackage: string
  targetName?: string
  resourcesToInclude: Map<string, string[]>
}

export interface PackageInclusionConfig {
  max_known_version?: string
  flags?: string[]
  include_uses_permissions?: string[]
  pregrantable_permissions?: string[]
  remove_permissions?: string[]
  sysconfig_inclusions?: string[]
  sysconfig_exclusions?: string[]
}

export interface PackagePermsConfig {
  pregrantablePerms: Set<string>
  removePerms: Set<string>
}

export function getPackagePermsConfig(pic: PackageInclusionConfig) {
  return {
    pregrantablePerms: new Set(pic.pregrantable_permissions ?? []),
    removePerms: new Set(pic.remove_permissions ?? []),
  } as PackagePermsConfig
}

interface DeviceListConfig {
  type: ConfigType.DeviceList
  devices: string[] // config paths

  // Not part of the final config
  // includes: string[]
}

// Untyped because this isn't a full config
export const EMPTY_FILTERS = {
  mode: FilterMode.Exclude,
  match: [],
  prefix: [],
  suffix: [],
  substring: [],
  regex: [],
} as SerializedFilters
// Same, but defaults to inclusion list
export const EMPTY_INCLUDE_FILTERS = {
  ...structuredClone(EMPTY_FILTERS),
  mode: FilterMode.Include,
} as SerializedFilters

const DEFAULT_CONFIG_BASE = {
  type: ConfigType.Device,
  device: {
    is_beta_build_id: false,
    is_beta_backport_build_id: false,
    odm_skus: [],
    gservices_flags: structuredClone(EMPTY_INCLUDE_FILTERS),
  },
  platform: {
    namespaces: [],
    extra_product_makefiles: [],
  },
  synthetic_overlays: {},
  filters: {
    overlay_keys: structuredClone(EMPTY_FILTERS),
    overlay_inclusions: structuredClone(EMPTY_FILTERS),
    overlay_files: structuredClone(EMPTY_FILTERS),
    partitions: structuredClone(EMPTY_FILTERS),
    file_exclusions: structuredClone(EMPTY_FILTERS),
    file_inclusions: structuredClone(EMPTY_INCLUDE_FILTERS),
  },
  package_exclusions: [],

  vintf_interface_exclusions: [],
  vintf_interface_inclusions: [],

  vintf_manifest_inclusions: {},
  vintf_manifest_exclusions: {},
  vintf_compat_matrix_exclusions: {},
  vintf_compat_matrix_inclusions: {},

  selinux_config_exclusions: {},
  selinux_config_inclusions: {},

  sysconfig_exclusions: [],
  sysconfig_inclusions: [],

  sysprop_exclusions: [],
  sysprop_inclusions: [],

  kernel_cmdline_exclusions: [],
  kernel_cmdline_inclusions: [],

  replacement_module_exclusions: [],
  replacement_module_inclusions: [],

  package_inclusions: {},
  installable_packages: [],

  backport_dirs: {},
  backport_files: {},

  extra_packages: [],

  apk_map: {},
  apex_map: {},
  unique_base_apks: [],
  unique_base_apexes: [],
}

export type DeviceBuildId = string

export function getDeviceBuildId(config: DeviceConfig, buildId: string = config.device.build_id) {
  return makeDeviceBuildId(config.device.name, resolveBuildId(buildId, config))
}

export function makeDeviceBuildId(deviceName: string, buildId: string) {
  return deviceName + ' ' + buildId
}

export function resolveBuildId(str: string, config: DeviceConfig) {
  switch (str) {
    case 'cur':
      return config.device.build_id!
    case 'prev':
      return config.device.prev_build_id!
    default: {
      return str
    }
  }
}

export const DEVICE_CONFIGS_FLAG = {
  devices: Flags.string({
    char: 'd',
    description: `Device or DeviceList config paths or names`,
    multiple: true,
    default: ['all'],
  }),
}

export const DEVICE_CONFIGS_FLAG_WITH_BUILD_ID = {
  ...DEVICE_CONFIGS_FLAG,
  buildId: Flags.string({
    char: 'b',
    description: 'override build id that is specified in device config',
  }),
}

interface DeviceConfigFlags {
  devices: string[]
  buildId?: string
}

export async function loadDeviceConfigs2(flags: DeviceConfigFlags) {
  return await loadDeviceConfigs(flags.devices, flags.buildId)
}

// Each string should refer to a Device or DeviceList config.
// There's two supported string formats: config path and config name from config dir (without .yml suffix),
// i.e. path/to/device_name.yml and device_name
export async function loadDeviceConfigs(strings: string[], buildIdOverride?: string) {
  const configFileSuffix = '.yml'

  let promises: Promise<DeviceConfig>[] = []

  for (let string of strings) {
    let configPath: string
    if (string.endsWith(configFileSuffix)) {
      configPath = string
    } else {
      configPath = path.join(DEVICE_CONFIG_DIR, string + configFileSuffix)
    }
    promises.push(...(await loadDeviceConfigsFromPath(configPath)))
  }

  // Map is used to make sure there's at most one config per device
  let map = new Map<string, DeviceConfig>()

  for await (let config of promises) {
    let key = config.device.name
    if (map.get(key) !== undefined) {
      console.warn(`loadDeviceConfigs: more than one config was passed for ${key}, only the last one will be used`)
    }
    if (buildIdOverride !== undefined) {
      config.device.build_id = buildIdOverride
    }
    map.set(key, config)
  }

  return Array.from(map.values())
}

async function loadAndMergeDeviceConfig(configPath: string) {
  return await loadAndMergeConfig(configPath, DEFAULT_CONFIG_BASE)
}

async function loadDeviceConfigFromPath(configPath: string): Promise<DeviceConfig> {
  let merged = await loadAndMergeDeviceConfig(configPath)
  let type = merged.type
  delete merged.type
  assert(type === ConfigType.Device)

  let res = merged as DeviceConfig
  checkConfigName(res, configPath)
  return res
}

function checkConfigName(config: DeviceConfig, configPath: string) {
  let configName = path.basename(configPath, '.yml')
  let deviceName = config.device.name
  assert(configName === deviceName, `config name doesn't match device name (${deviceName}): ${configPath}`)
}

async function loadDeviceConfigsFromPath(configPath: string): Promise<Promise<DeviceConfig>[]> {
  let merged = await loadAndMergeDeviceConfig(configPath)
  let type = merged.type
  delete merged.type

  if (type === ConfigType.Device) {
    let res = merged as DeviceConfig
    checkConfigName(res, configPath)
    return [Promise.resolve(res)]
  } else if (type === ConfigType.DeviceList) {
    // Load all the device configs
    let list = merged as DeviceListConfig
    let devices: Promise<DeviceConfig>[] = []
    for (let devicePath of list.devices) {
      devicePath = path.resolve(path.dirname(configPath), devicePath)
      devices.push(loadDeviceConfigFromPath(devicePath))
    }
    return devices
  }
  throw new Error(`Unknown config type ${type}`)
}

export function getDeviceNames(configs: DeviceConfig[]) {
  return configs.map(c => c.device.name).join(' ')
}
