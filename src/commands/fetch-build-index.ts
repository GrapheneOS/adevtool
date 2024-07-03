import { Command, Flags } from '@oclif/core'
import { YAMLMap } from 'yaml/types'

import { DEVICE_CONFIG_FLAGS, loadDeviceConfigs } from '../config/device'
import { fetchBetaBuildIndex, fetchBuildIndex } from '../images/build-index'
import { yamlStringifyNoFold } from '../util/yaml'

export default class FetchBuildIndex extends Command {
  description = 'fetch main or beta build index and print it out as YAML'

  static flags = {
    ...DEVICE_CONFIG_FLAGS,
    beta: Flags.string({
      char: 'b',
      description: 'Fetch index of beta builds for the specified major OS version (e.g. -b 14)',
    }),
  }

  async run() {
    let { flags } = await this.parse(FetchBuildIndex)
    let devices = await loadDeviceConfigs(flags.devices)

    let index: YAMLMap
    if (flags.beta === undefined) {
      index = await fetchBuildIndex(devices)
    } else {
      index = await fetchBetaBuildIndex(devices, flags.beta)
    }

    let yaml = yamlStringifyNoFold(index)
    this.log(yaml)
  }
}
