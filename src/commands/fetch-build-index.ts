import { Command, Flags } from '@oclif/core'
import { YAMLMap } from 'yaml'

import assert from 'assert'
import YAML, { Document } from 'yaml'
import {
  DEVICE_CONFIGS_FLAG,
  DeviceBuildId,
  DeviceConfig,
  loadDeviceConfigs,
  makeDeviceBuildId,
} from '../config/device'
import { BuildIndex, BuildProps, fetchBetaBuildIndex, fetchBuildIndex, ImageType } from '../images/build-index'
import { readFile } from '../util/fs'

export default class FetchBuildIndex extends Command {
  description = 'fetch main or beta build index and print it out as YAML'

  static flags = {
    ...DEVICE_CONFIGS_FLAG,
    beta: Flags.string({
      description: 'Fetch index of beta builds for the specified major OS version (e.g. --beta 14)',
    }),
    canary: Flags.string({
      description: 'Fetch index of canary builds from a Markdown file',
    }),
  }

  async run() {
    let { flags } = await this.parse(FetchBuildIndex)
    let devices = await loadDeviceConfigs(flags.devices)

    let index: YAMLMap
    if (flags.beta !== undefined) {
      index = await fetchBetaBuildIndex(devices, flags.beta)
    } else if (flags.canary !== undefined) {
      index = await parseCanaryBuildIndex(devices, flags.canary)
    } else {
      index = await fetchBuildIndex(devices)
    }

    let yaml = YAML.stringify(index, { lineWidth: 0 })
    this.log(yaml)
  }
}

async function parseCanaryBuildIndex(deviceConfigs: DeviceConfig[], srcFilePath: string) {
  let deviceNames = new Set<string>()
  for (let config of deviceConfigs) {
    deviceNames.add(config.device.name)
  }

  let buildIndex: BuildIndex = new Map<DeviceBuildId, BuildProps>()

  let builds = (await readFile(srcFilePath)).split('# Android Canary ')
  for (let build of builds) {
    if (build.length === 0) {
      continue
    }
    let lines = build.split('\n')
    let buildIdLine = lines[0]
    let buildIdStart = buildIdLine.indexOf('ZP1')
    assert(buildIdStart > 0, buildIdLine)
    let buildIdEnd = buildIdLine.indexOf(' ', buildIdStart)
    assert(buildIdEnd > buildIdStart, buildIdLine)
    let buildId = buildIdLine.substring(buildIdStart, buildIdEnd)
    for (let line of lines.slice(1)) {
      let parts = line.split(' | ')
      if (parts.length < 4) {
        continue
      }
      let devicePart = parts[0]
      let deviceStart = devicePart.lastIndexOf('(')
      if (deviceStart < 2) {
        continue
      }
      deviceStart += 1
      let deviceEnd = devicePart.lastIndexOf(')')
      assert(deviceEnd > deviceStart, line)
      let device = devicePart.substring(deviceStart, deviceEnd)
      if (!deviceNames.has(device)) {
        continue
      }
      let dlPart = parts[2]
      let dlPrefix = '[Link]('
      assert(dlPart.startsWith(dlPrefix), line)
      assert(dlPart.endsWith(')'), line)
      let dlLink = dlPart.slice(dlPrefix.length, -1)
      let sha256 = parts[3]
      assert(sha256.endsWith(' |'), line)
      sha256 = sha256.slice(0, -2)
      let props = new Map<string, string>()
      props.set(ImageType.Factory, sha256 + ' ' + dlLink)
      buildIndex.set(makeDeviceBuildId(device, buildId), props)
    }
  }
  return new Document().createNode(buildIndex) as YAMLMap
}
