import { Args, Command, Flags } from '@oclif/core'
import { run } from '../util/process'
import { readFile } from '../util/fs'

import YAML from 'yaml'

export default class ExtractFirmware extends Command {
  static description = 'extract firmware partitions'

  static flags = {
    help: Flags.help({ char: 'h' }),
    factoryOtaPath: Flags.string({
      char: 'f',
      description: 'path to stock factory OTA images zip (for extracting firmware)',
      required: true,
    }),
  }

  static args = {
    configPath: Args.string({
      description: 'path to device-specific YAML config',
      required: true,
    }),
  }

  async run() {
    let {
      args: { configPath },
      flags: { factoryOtaPath },
    } = await this.parse(ExtractFirmware)

    // parse config file
    let config = YAML.parse(await readFile(configPath))
    let vendor = 'google_devices'
    let device = config.device.name

    let outDir = `vendor/${vendor}/${device}/firmware`
    await run(
      __dirname +
        `/../../external/extract_android_ota_payload/extract_android_ota_payload.py ${factoryOtaPath} ${outDir}`,
    )
  }
}
