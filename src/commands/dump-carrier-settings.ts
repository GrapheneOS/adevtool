import { Command, Flags } from '@oclif/core'
import path from 'path'

import { DEVICE_CONFIG_FLAGS, getDeviceBuildId, loadDeviceConfigs } from '../config/device'
import { decodeConfigs } from '../blobs/carrier'
import { forEachDevice } from '../frontend/devices'
import { BuildIndex, loadBuildIndex } from '../images/build-index'
import { prepareFactoryImages } from '../frontend/source'
import { exists } from '../util/fs'
import { CARRIER_SETTINGS_FACTORY_PATH, VENDOR_MODULE_SKELS_DIR } from '../config/paths'
import assert from 'assert'

export default class DumpCarrierSettings extends Command {
  static description = 'generate protoc dumps of configs from factory image.'

  static flags = {
    buildId: Flags.string({
      description: 'specify build ID',
      char: 'b',
    }),
    out: Flags.string({
      char: 'o',
    }),
    ...DEVICE_CONFIG_FLAGS,
  }

  async run() {
    let { flags } = await this.parse(DumpCarrierSettings)
    let index: BuildIndex = await loadBuildIndex()
    let devices = await loadDeviceConfigs(flags.devices)
    await forEachDevice(
      devices,
      false,
      async config => {
        if (config.device.has_cellular) {
          const build_id = flags.buildId ?? config.device.build_id
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
      config => `${config.device.name} ${flags.buildId ?? config.device.build_id}`,
    )
  }
}
