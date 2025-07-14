import promiseSpawn from '@npmcli/promise-spawn'
import assert from 'assert'
import { Mutex } from 'async-mutex'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'path'
import { isFile } from '../util/fs'
import { spawnAsync } from '../util/process'

export const OS_CHECKOUT_DIR = getOsCheckoutDir()

function getOsCheckoutDir(): string {
  let fromEnv = process.env.ANDROID_BUILD_TOP
  if (fromEnv !== undefined) {
    return fromEnv
  }
  let scriptDir = '/vendor/adevtool/src/config'
  assert(__dirname.endsWith(scriptDir))
  return __dirname.substring(0, __dirname.length - scriptDir.length)
}

export const RELATIVE_ADEVTOOL_PATH = 'vendor/adevtool'
export const ADEVTOOL_DIR = path.join(OS_CHECKOUT_DIR, RELATIVE_ADEVTOOL_PATH)

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

let builtDependencies = process.env['ADEVTOOL_SKIP_DEP_BUILD'] === '1'

let depBuildMutex = new Mutex()

export async function getHostBinPath(programName: string) {
  let outDir = 'out_adevtool_deps'

  async function getAdevtoolRevision() {
    return spawnAsync('git', ['-C', ADEVTOOL_DIR, 'rev-parse', 'HEAD'])
  }

  function getAdevtoolRevisionFile(outDir: string) {
    return path.join(getOsCheckoutDir(), outDir, 'adevtool_revision')
  }

  return await depBuildMutex.runExclusive(async () => {
    if (!builtDependencies) {
      let adevtoolRevisionFile = getAdevtoolRevisionFile(outDir)
      try {
        let revision = await readFile(adevtoolRevisionFile, { encoding: 'utf8' })
        builtDependencies = revision === (await getAdevtoolRevision())
      } catch (e) {
        /* empty */
      }
    }

    let progPath = path.join(getOsCheckoutDir(), outDir, 'host/linux-x86/bin', programName)
    // build deps at least once in case they've changed
    if (builtDependencies && (await isFile(progPath))) {
      return progPath
    }

    let knownPrograms = ['aapt2', 'aprotoc', 'arsclib', 'debugfs', 'fsck.erofs', 'lz4', 'ota_extractor', 'toybox']
    if (!knownPrograms.includes(programName)) {
      throw new Error('unknown program: ' + programName)
    }

    if (await isFile(progPath)) {
      console.log('\nRebuilding adevtool dependencies...')
      console.log('Rebuild can be skipped by setting ADEVTOOL_SKIP_DEP_BUILD env variable to 1\n')
    } else {
      console.log('\nBuilding adevtool dependencies...\n')
    }

    let label = '\nBuild completed in'
    console.time(label)
    // Currently program name and build target name match
    await promiseSpawn(
      path.join(ADEVTOOL_DIR, 'scripts/run-build.sh'),
      ['sdk_phone64_x86_64', outDir, ...knownPrograms],
      { stdio: 'inherit' },
    )
    console.timeEnd(label)

    if (!(await isFile(progPath))) {
      throw new Error(programName + ' is missing after successful build')
    }

    await writeFile(getAdevtoolRevisionFile(outDir), await getAdevtoolRevision())

    builtDependencies = true

    return progPath
  })
}
