import { Command, Flags } from '@oclif/core'

import {
  downloadAllConfigs,
  fetchUpdateConfig,
  getCarrierSettingsBuildId,
  getCarrierSettingsUpdatesDir,
} from '../blobs/carrier'
import { loadPartitionProps } from '../blobs/props'
import { DEVICE_CONFIGS_FLAG_WITH_BUILD_ID, getDeviceBuildId, loadDeviceConfigs2 } from '../config/device'
import { forEachDevice } from '../frontend/devices'
import { prepareFactoryImages } from '../frontend/source'
import { loadBuildIndex } from '../images/build-index'
import { mapGet } from '../util/data'
import { log } from '../util/log'
import { PathResolver, PathResolverContext } from '../util/partitions'

export default class UpdateCarrierSettings extends Command {
  static description = 'download updated carrier protobuf configs.'

  static flags = {
    out: Flags.string({
      char: 'o',
      description: 'override output directory',
    }),
    debug: Flags.boolean({
      description: 'enable debug output',
      default: false,
    }),
    ...DEVICE_CONFIGS_FLAG_WITH_BUILD_ID,
  }

  async run() {
    let { flags } = await this.parse(UpdateCarrierSettings)
    let devices = await loadDeviceConfigs2(flags)
    let buildIndex = await loadBuildIndex()
    await forEachDevice(
      devices,
      false,
      async config => {
        if (config.device.has_cellular) {
          const buildId = flags.buildId ?? getCarrierSettingsBuildId(config)
          const outDir = flags.out ?? getCarrierSettingsUpdatesDir(config)
          let factoryImages = await prepareFactoryImages(buildIndex, [config], [buildId])
          let factoryImageDir = mapGet(factoryImages, getDeviceBuildId(config, buildId)).unpackedFactoryImageDir
          let stockProps = await loadPartitionProps(
            new PathResolver(factoryImageDir, PathResolverContext.UNPACKED_IMAGE),
          )
          const updateConfig = await fetchUpdateConfig(config.device.name, stockProps, flags.debug)
          if (flags.debug) log(JSON.stringify(Object.fromEntries(updateConfig), null, 2))
          await downloadAllConfigs(updateConfig, outDir, flags.debug)
        } else {
          this.log(`${config.device.name} is not supported due to lack of cellular connectivity`)
        }
      },
      config => `${config.device.name} ${flags.buildId ?? getCarrierSettingsBuildId(config)}`,
    )
  }
}
