import { Command } from '@oclif/core'
import chalk from 'chalk'

import { DEVICE_CONFIG_FLAGS, DeviceConfig, getDeviceNames, loadDeviceConfigs } from '../config/device'
import { ImageType, loadBuildIndex } from '../images/build-index'
import { DeviceImage } from '../images/device-image'
import { updateMultiMap } from '../util/data'
import { loadBuildIdToTagMap } from './update-aosp-tag-index'

export default class ShowStatus extends Command {
  static flags = {
    ...DEVICE_CONFIG_FLAGS,
  }

  async run() {
    let { flags } = await this.parse(ShowStatus)
    let configs = await loadDeviceConfigs(flags.devices)

    let buildIdMap = new Map<string, DeviceConfig[]>()
    // platform security patch levels
    let psplMap = new Map<string, DeviceConfig[]>()
    let imageIndex = await loadBuildIndex()
    let presentImages = new Map<string, DeviceConfig[]>()
    let missingImages = new Map<string, DeviceConfig[]>()
    let unknownImages = new Map<string, DeviceConfig[]>()
    let imageTypes = [ImageType.Factory, ImageType.Ota]

    for (let config of configs) {
      updateMultiMap(buildIdMap, config.device.build_id, config)
      updateMultiMap(psplMap, config.device.platform_security_patch_level_override, config)

      for (let type of imageTypes) {
        let image: DeviceImage
        try {
          image = DeviceImage.get(imageIndex, config, config.device.build_id, type)
        } catch {
          updateMultiMap(unknownImages, type, config)
          continue
        }

        if (await image.isPresent()) {
          updateMultiMap(presentImages, type, config)
        } else {
          updateMultiMap(missingImages, type, config)
        }
      }
    }

    let buildIdToTag = await loadBuildIdToTagMap()

    this.log(chalk.bold('Tag | Build ID:'))
    for (let [buildId, configs] of buildIdMap.entries()) {
      this.log(`${buildIdToTag?.get(buildId) ?? '[no tag]'} | ${buildId}: ` + getDeviceNames(configs))
    }

    if (psplMap.size > 0) {
      this.log(chalk.bold('\nPlatform security patch level:'))
      for (let [spl, configs] of psplMap.entries()) {
        this.log((spl === undefined ? 'default' : spl) + ': ' + getDeviceNames(configs))
      }
    }

    this.log(chalk.bold('\nStock image:'))
    for (let type of imageTypes) {
      this.log(`  ${type}:`)
      this.maybeLogImageStatus(type, presentImages, 'present')
      this.maybeLogImageStatus(type, missingImages, 'known')
      this.maybeLogImageStatus(type, unknownImages, chalk.bold(chalk.red('unknown')))
    }
    if (unknownImages.size !== 0) {
      process.exit(1)
    }
  }

  maybeLogImageStatus(type: ImageType, map: Map<string, DeviceConfig[]>, mapName: string) {
    let devices = map.get(type)
    if (devices !== undefined && devices.length > 0) {
      this.log(`    ${mapName}: ${getDeviceNames(devices)}`)
    }
  }
}
