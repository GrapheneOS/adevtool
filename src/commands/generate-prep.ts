import { Command, Flags } from '@oclif/core'

import { createVendorDirs, writeVersionCheckFile } from '../blobs/build'
import { copyBlobs } from '../blobs/copy'
import { BlobEntry } from '../blobs/entry'
import {
  DEVICE_CONFIGS_FLAG_WITH_BUILD_ID,
  DeviceBuildId,
  DeviceConfig,
  getDeviceBuildId,
  loadDeviceConfigs2,
} from '../config/device'
import { forEachDevice } from '../frontend/devices'
import {
  enumerateFiles,
  extractProps,
  generateBuildFiles,
  PropResults,
  writeEnvsetupCommands,
} from '../frontend/generate'
import { DeviceImages, prepareFactoryImages } from '../frontend/source'
import { loadBuildIndex } from '../images/build-index'

export async function generatePrep(config: DeviceConfig, stockSrc: string) {
  return await doDevice(config, stockSrc, false)
}

async function doDevice(config: DeviceConfig, stockSrc: string, skipCopy: boolean) {
  // these jars are expected to reference proprietary files that are
  // inaccessible during state collection build
  config.platform.extra_product_system_server_jars = []

  // Each step will modify this. Key = combined part path
  let namedEntries = new Map<string, BlobEntry>()

  // Prepare output directories
  let dirs = await createVendorDirs(config.device.vendor, config.device.name)

  // 1. Diff files
  await enumerateFiles(config.filters.dep_files, null, namedEntries, null, stockSrc)

  // After this point, we only need entry objects
  let entries = Array.from(namedEntries.values())

  // 2. Extract
  // Copy blobs (this has its own spinner)
  if (config.generate.files && !skipCopy) {
    await copyBlobs(entries, stockSrc, dirs.proprietary)
  }

  // 3. Props
  let propResults: PropResults | null = null
  if (config.generate.props) {
    propResults = await extractProps(config, null, stockSrc)
    delete propResults.missingProps
    delete propResults.fingerprint
  }

  // 4. Build files
  await generateBuildFiles(config, dirs, entries, [], propResults, null, null, null, null, stockSrc, false, true)

  await writeEnvsetupCommands(config, dirs)
  await writeVersionCheckFile(config, dirs)

  console.log('generated prep vendor module at ' + dirs.out)
  return dirs.out
}

export default class GeneratePrep extends Command {
  static description = 'generate vendor parts to prepare for reference AOSP build (e.g. for collect-state)'

  static flags = {
    help: Flags.help({ char: 'h' }),
    skipCopy: Flags.boolean({
      char: 'k',
      description: 'skip file copying and only generate build files',
      default: false,
    }),
    parallel: Flags.boolean({
      char: 'p',
      description: 'generate devices in parallel (causes buggy progress spinners)',
      default: false,
    }),

    ...DEVICE_CONFIGS_FLAG_WITH_BUILD_ID,
  }

  async run() {
    let { flags } = await this.parse(GeneratePrep)
    let devices = await loadDeviceConfigs2(flags)

    let deviceImagesMap: Map<DeviceBuildId, DeviceImages> = await prepareFactoryImages(await loadBuildIndex(), devices)

    await forEachDevice(
      devices,
      flags.parallel,
      async config => {
        let deviceImages = deviceImagesMap.get(getDeviceBuildId(config))!
        let stockSrc = deviceImages.unpackedFactoryImageDir

        await doDevice(config, stockSrc, flags.skipCopy)
      },
      config => config.device.name,
    )
  }
}
