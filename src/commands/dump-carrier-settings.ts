import { Command, Flags } from '@oclif/core'
import path from 'path'

import assert from 'assert'
import { decodeConfigs } from '../blobs/carrier'
import { DEVICE_CONFIGS_FLAG_WITH_BUILD_ID, getDeviceBuildId, loadDeviceConfigs2 } from '../config/device'
import { CARRIER_SETTINGS_FACTORY_PATH, VENDOR_MODULE_SKELS_DIR } from '../config/paths'
import { forEachDevice } from '../frontend/devices'
import { prepareFactoryImages } from '../frontend/source'
import { BuildIndex, loadBuildIndex } from '../images/build-index'
import { exists } from '../util/fs'

export default class DumpCarrierSettings extends Command {
  static description = 'generate protoc dumps of configs from factory image.'

  static flags = {
    out: Flags.string({
      char: 'o',
    }),
    ...DEVICE_CONFIGS_FLAG_WITH_BUILD_ID,
  }

  async run() {
    let { flags } = await this.parse(DumpCarrierSettings)
    let index: BuildIndex = await loadBuildIndex()
    let devices = await loadDeviceConfigs2(flags)
    await forEachDevice(
      devices,
      false,
      async config => {
        if (config.device.has_cellular) {
          const build_id = config.device.build_id
          const images = await prepareFactoryImages(index, [config], [build_id])
          const deviceImages = images.get(getDeviceBuildId(config, build_id))!
          const stockCsPath = path.join(deviceImages.unpackedFactoryImageDir, CARRIER_SETTINGS_FACTORY_PATH)
          const defaultOutDir = path.join(
            VENDOR_MODULE_SKELS_DIR,
            config.device.vendor,
            config.device.name,
            'proprietary',
            CARRIER_SETTINGS_FACTORY_PATH,
          )
          const outDir = flags.out !== undefined ? path.join(flags.out, config.device.name) : defaultOutDir
          assert(await exists(stockCsPath))
          await decodeConfigs(stockCsPath, outDir)
        } else {
          this.log(`${config.device.name} is not supported due to lack of cellular connectivity`)
        }
      },
      config => `${config.device.name} ${config.device.build_id}`,
    )
  }
}
