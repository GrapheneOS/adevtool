import assert from 'assert'
import path from 'path'

export const OS_CHECKOUT_DIR = getOsCheckoutDir()

function getOsCheckoutDir(): string {
  let scriptDir = '/vendor/adevtool/src/config'
  assert(__dirname.endsWith(scriptDir))
  return __dirname.substring(0, __dirname.length - scriptDir.length)
}

export const ADEVTOOL_DIR = path.join(OS_CHECKOUT_DIR, 'vendor/adevtool')

export const CONFIG_DIR = process.env['ADEVTOOL_CONFIG_DIR'] ?? path.join(ADEVTOOL_DIR, 'config')
export const DEVICE_CONFIG_DIR = path.join(CONFIG_DIR, 'device')
// $DEVICE.json files made by collect-state command
export const COLLECTED_SYSTEM_STATE_DIR =
  process.env['ADEVTOOL_SYSTEM_STATE_DIR'] ?? path.join(OS_CHECKOUT_DIR, 'vendor/state')

export const BUILD_INDEX_DIR = path.join(CONFIG_DIR, 'build-index')
export const BUILD_INDEX_FILE = path.join(BUILD_INDEX_DIR, 'build-index.yml')
export const MAIN_BUILD_INDEX_PART = path.join(BUILD_INDEX_DIR, 'build-index-main.yml')

export const IMAGE_DOWNLOAD_DIR = process.env['ADEVTOOL_IMG_DOWNLOAD_DIR'] ?? path.join(ADEVTOOL_DIR, 'dl')

export const BUILD_ID_TO_TAG_FILE = path.join(BUILD_INDEX_DIR, 'build-id-to-tag.yml')

export const VENDOR_MODULE_SPECS_DIR = path.join(ADEVTOOL_DIR, 'vendor-specs')
export const VENDOR_MODULE_SKELS_DIR = path.join(ADEVTOOL_DIR, 'vendor-skels')

export const CARRIER_SETTINGS_DIR = path.join(ADEVTOOL_DIR, 'carrier-settings')
export const CARRIER_SETTINGS_FACTORY_PATH = 'product/etc/CarrierSettings'
