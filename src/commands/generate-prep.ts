import { Command, Flags } from '@oclif/core'
import assert from 'assert'

import { createVendorDirs } from '../blobs/build'
import { copyBlobs } from '../blobs/copy'
import { BlobEntry } from '../blobs/entry'
import { DEVICE_CONFIG_FLAGS, DeviceBuildId, DeviceConfig, getDeviceBuildId, loadDeviceConfigs } from '../config/device'
import { forEachDevice } from '../frontend/devices'
import {
  enumerateFiles,
  extractProps,
  generateBuildFiles,
  PropResults,
  writeEnvsetupCommands,
} from '../frontend/generate'
import { DeviceImages, prepareFactoryImages, WRAPPED_SOURCE_FLAGS, wrapSystemSrc } from '../frontend/source'
import { loadBuildIndex } from '../images/build-index'
import { withSpinner } from '../util/cli'
import { withTempDir } from '../util/fs'

export async function generatePrep(config: DeviceConfig, stockSrc: string, buildId: string) {
  await doDevice(config, stockSrc, buildId, false, false)
}

const doDevice = (
  config: DeviceConfig,
  stockSrc: string,
  buildId: string | undefined,
  skipCopy: boolean,
  useTemp: boolean,
) =>
  withTempDir(async tmp => {
    // these jars are expected to reference proprietary files that are
    // inaccessible during state collection build
    config.platform.extra_product_system_server_jars = []

    // Prepare stock system source
    let wrapBuildId = buildId == undefined ? null : buildId
    let wrapped = await withSpinner('Extracting stock system source', spinner =>
      wrapSystemSrc(stockSrc, config.device.name, wrapBuildId, useTemp, tmp, spinner),
    )
    stockSrc = wrapped.src!

    // Each step will modify this. Key = combined part path
    let namedEntries = new Map<string, BlobEntry>()

    // Prepare output directories
    let dirs = await createVendorDirs(config.device.vendor, config.device.name)

    // 1. Diff files
    await withSpinner('Enumerating files', spinner =>
      enumerateFiles(spinner, config.filters.dep_files, null, namedEntries, null, stockSrc),
    )

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
      propResults = await withSpinner('Extracting properties', () => extractProps(config, null, stockSrc))
      delete propResults.missingProps
      delete propResults.fingerprint
    }

    // 4. Build files
    await withSpinner('Generating build files', () =>
      generateBuildFiles(config, dirs, entries, [], propResults, null, null, null, null, stockSrc, false, true),
    )

    await writeEnvsetupCommands(config, dirs)
  })

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

    ...WRAPPED_SOURCE_FLAGS,
    ...DEVICE_CONFIG_FLAGS,
  }

  static {
    GeneratePrep.flags.stockSrc.required = false
  }

  async run() {
    let { flags } = await this.parse(GeneratePrep)
    let devices = await loadDeviceConfigs(flags.devices)

    let useImagesFromConfig = flags.stockSrc === undefined

    let deviceImagesMap: Map<DeviceBuildId, DeviceImages>

    if (useImagesFromConfig) {
      assert(flags.stockSrc === undefined)
      assert(flags.buildId === undefined)
      assert(!flags.useTemp)
      deviceImagesMap = await prepareFactoryImages(await loadBuildIndex(), devices)
    }

    await forEachDevice(
      devices,
      flags.parallel,
      async config => {
        let stockSrc: string
        let buildId: string | undefined
        if (useImagesFromConfig) {
          let deviceImages = deviceImagesMap.get(getDeviceBuildId(config))!
          stockSrc = deviceImages.unpackedFactoryImageDir
          buildId = config.device.build_id
        } else {
          stockSrc = flags.stockSrc!
          buildId = flags.buildId
        }

        await doDevice(config, stockSrc, buildId, flags.skipCopy, flags.useTemp)
      },
      config => config.device.name,
    )
  }
}
