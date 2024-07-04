import assert from 'assert'
import { promises as fs } from 'fs'
import path from 'path'
import { DeviceConfig, getDeviceBuildId } from '../config/device'
import { IMAGE_DOWNLOAD_DIR } from '../config/paths'
import { BuildIndex, DEFAULT_BASE_DOWNLOAD_URL, ImageType } from './build-index'

const GRAPHENEOS_PSEUDO_BUILD_ID_PREFIX = 'gos-'

export class DeviceImage {
  constructor(
    readonly deviceConfig: DeviceConfig,
    readonly type: ImageType,
    readonly buildId: string,
    readonly fileName: string,
    readonly sha256: string,
    readonly url: string,
    readonly skipSha256Check: boolean,
    readonly isGrapheneOS: boolean,
  ) {}

  getPath() {
    return path.join(IMAGE_DOWNLOAD_DIR, this.fileName)
  }

  async isPresent() {
    try {
      return (await fs.stat(this.getPath())).isFile()
    } catch {
      return false
    }
  }

  static get(index: BuildIndex, deviceConfig: DeviceConfig, buildId: string, type: ImageType) {
    let deviceBuildId = getDeviceBuildId(deviceConfig, buildId)
    let buildProps = index.get(deviceBuildId)
    if (buildProps === undefined) {
      if (buildId.startsWith(GRAPHENEOS_PSEUDO_BUILD_ID_PREFIX)) {
        let fileName =
          deviceConfig.device.name + '-factory-' + buildId.substring(GRAPHENEOS_PSEUDO_BUILD_ID_PREFIX.length) + '.zip'

        let url = 'https://releases.grapheneos.org/' + fileName

        return new DeviceImage(deviceConfig, type, buildId, fileName, 'no sha256', url, true, true)
      }

      throw new Error(`no images for '${deviceBuildId}'`)
    }

    let str = buildProps.get(type)

    if (str === undefined) {
      throw new Error(`no ${type} image for '${deviceBuildId}'`)
    }

    let split = str.split(' ')
    assert(split.length == 2)
    let sha256 = split[0]
    let ending = split[1]
    let url: string
    let fileName: string
    if (ending.includes('/')) {
      url = ending
      fileName = path.basename(url)
    } else {
      fileName = ending
      url = DEFAULT_BASE_DOWNLOAD_URL + fileName
    }
    return new DeviceImage(deviceConfig, type, buildId, fileName, sha256, url, false, false)
  }

  static async getMissing(arr: DeviceImage[]) {
    let res: DeviceImage[] = []
    let imagePresence = arr.map(i => ({ image: i, isPresent: i.isPresent() }))
    for (let e of imagePresence) {
      if (!(await e.isPresent)) {
        res.push(e.image)
      }
    }
    return res
  }

  toString() {
    return `'${this.deviceConfig.device.name} ${this.buildId} ${this.type}'`
  }

  static arrayToString(arr: DeviceImage[]) {
    return arr.map(i => i.toString()).join(', ')
  }
}
