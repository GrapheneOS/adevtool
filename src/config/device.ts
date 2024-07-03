// Breaks build with import, needed for structuredClone definition
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
///<reference path="../util/jstypes.d.ts" />

import { Flags } from '@oclif/core'
import assert from 'assert'
import path from 'path'

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

export interface DeviceConfig {
  // Required
  device: {
    name: string
    vendor: string
    // file system type of OS partitions
    system_fs_type: FsType
    kernel_repo_url: string
    build_id: string
    prev_build_id: string
    has_cellular: boolean
    // ignored when undefined
    platform_security_patch_level_override?: string
  }

  platform: {
    namespaces: string[]
    sepolicy_dirs: string[]
    product_makefile: string // required
    // not included in makefile for state collection build (generate-prep)
    extra_product_makefiles: string[]
    extra_product_system_server_jars: string[]
    vendor_linker_config: object
  }

  generate: {
    overrides: boolean
    presigned: boolean
    flat_apex: boolean
    files: boolean
    props: boolean
    sepolicy_dirs: boolean
    overlays: boolean
    vintf: boolean
    factory_firmware: boolean
    ota_firmware: boolean // not yet implemented
    products: boolean
  }

  // Not part of the final config
  // includes: string[]

  filters: {
    props: Filters
    overlay_keys: Filters
    overlay_values: Filters
    overlay_files: Filters
    partitions: Filters
    presigned: Filters
    sepolicy_dirs: Filters
    dep_files: Filters
    files: Filters
    deprivileged_apks: Filters
  }
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
  platform: {
    namespaces: [],
    sepolicy_dirs: [],
    extra_product_makefiles: [],
    extra_product_system_server_jars: [],
    vendor_linker_config: {},
  },
  generate: {
    overrides: true,
    presigned: true,
    flat_apex: false, // currently broken
    files: true,
    props: true,
    sepolicy_dirs: true,
    overlays: true,
    vintf: true,
    factory_firmware: true,
    ota_firmware: true,
    products: true,
  },
  filters: {
    props: structuredClone(EMPTY_FILTERS),
    overlay_keys: structuredClone(EMPTY_FILTERS),
    overlay_values: structuredClone(EMPTY_FILTERS),
    overlay_files: structuredClone(EMPTY_FILTERS),
    partitions: structuredClone(EMPTY_FILTERS),
    presigned: structuredClone(EMPTY_INCLUDE_FILTERS),
    sepolicy_dirs: structuredClone(EMPTY_FILTERS),
    dep_files: structuredClone(EMPTY_INCLUDE_FILTERS),
    files: structuredClone(EMPTY_FILTERS),
    deprivileged_apks: structuredClone(EMPTY_INCLUDE_FILTERS),
  },
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

export const DEVICE_CONFIG_FLAGS = {
  devices: Flags.string({
    char: 'd',
    description: `Device or DeviceList config paths or names`,
    multiple: true,
    default: ['all'],
  }),
}

// Each string should refer to a Device or DeviceList config.
// There's two supported string formats: config path and config name from config dir (without .yml suffix),
// i.e. path/to/device_name.yml and device_name
export async function loadDeviceConfigs(strings: string[]) {
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
