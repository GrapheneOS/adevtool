import { Command } from '@oclif/core'
import { readFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { YAMLMap } from 'yaml/types'

import { DEVICE_CONFIG_FLAGS, loadDeviceConfigs } from '../config/device'
import { ADEVTOOL_DIR, MAIN_BUILD_INDEX_PART } from '../config/paths'
import { fetchBuildIndex } from '../images/build-index'
import { showGitDiff } from '../util/cli'
import { yamlStringifyNoFold } from '../util/yaml'

export default class UpdateBuildIndex extends Command {
  static description =
    'fetch main (non-beta) build index and if it has changed, update build-index-main.yml file in-place and show git diff'

  static flags = DEVICE_CONFIG_FLAGS

  async run() {
    let { flags } = await this.parse(UpdateBuildIndex)
    let devices = await loadDeviceConfigs(flags.devices)

    let index: YAMLMap = await fetchBuildIndex(devices)

    let yaml = yamlStringifyNoFold(index)

    if (readFileSync(MAIN_BUILD_INDEX_PART).toString() === yaml) {
      this.log('main build index is up-to-date')
      process.exit(1)
    }

    await writeFile(MAIN_BUILD_INDEX_PART, yaml)
    showGitDiff(ADEVTOOL_DIR, MAIN_BUILD_INDEX_PART)
  }
}
