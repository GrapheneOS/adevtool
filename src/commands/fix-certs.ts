import { Command, Flags } from '@oclif/core'

import assert from 'assert'
import { DEVICE_CONFIGS_FLAG_WITH_BUILD_ID, getDeviceBuildId, loadDeviceConfigs2 } from '../config/device'
import { prepareFactoryImages } from '../frontend/source'
import { loadBuildIndex } from '../images/build-index'
import {
  KeyInfo,
  MacSigner,
  readKeysConfRecursive,
  readMacPermissionsRecursive,
  readPartMacPermissions,
  resolveKeys,
  writeMappedKeys,
} from '../selinux/keys'

export default class FixCerts extends Command {
  static description = 'fix SELinux presigned app certificates'

  static flags = {
    help: Flags.help({ char: 'h' }),
    sepolicy: Flags.string({
      char: 'p',
      description: 'paths to device and vendor sepolicy dirs',
      required: true,
      multiple: true,
    }),

    ...DEVICE_CONFIGS_FLAG_WITH_BUILD_ID,
  }

  async run() {
    let { flags } = await this.parse(FixCerts)

    let devices = await loadDeviceConfigs2(flags)
    let images = await prepareFactoryImages(await loadBuildIndex(), devices)

    assert(devices.length === 1)

    let config = devices[0]
    let deviceImages = images.get(getDeviceBuildId(config))!
    let srcSigners: Array<MacSigner> = []
    let srcKeys: Array<KeyInfo> = []
    for (let dir of flags.sepolicy) {
      srcSigners.push(...(await readMacPermissionsRecursive(dir)))
      srcKeys.push(...(await readKeysConfRecursive(dir)))
    }

    let compiledSigners = await readPartMacPermissions(deviceImages.unpackedFactoryImageDir)
    let keys = resolveKeys(srcKeys, srcSigners, compiledSigners)

    for (let paths of keys.values()) {
      for (let path of paths) {
        this.log(path)
      }
    }

    await writeMappedKeys(keys)
  }
}
