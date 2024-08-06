import { Args, Command, Flags } from '@oclif/core'
import { promises as fs } from 'fs'
import chalk from 'chalk'

import { diffVintfHals, getHalFqNames, loadPartVintfInfo, serializeVintfHals } from '../blobs/vintf'
import { EXT_PARTITIONS } from '../util/partitions'

export default class DiffVintf extends Command {
  static description = 'find missing vintf declarations compared to a reference system'

  static flags = {
    help: Flags.help({ char: 'h' }),
    all: Flags.boolean({
      char: 'a',
      description: 'show all differences, not only missing/removed HALs',
      default: false,
    }),
  }

  static args = {
    sourceRef: Args.string({
      description: 'path to root of reference system',
      required: true,
    }),
    sourceNew: Args.string({
      description: 'path to root of new system',
      required: true,
    }),
    outPath: Args.string({
      description: 'output path for manifest fragment with missing HALs',
    }),
  }

  async run() {
    let {
      flags: { all },
      args: { sourceRef, sourceNew, outPath },
    } = await this.parse(DiffVintf)

    let vintfRef = await loadPartVintfInfo(sourceRef)
    let vintfNew = await loadPartVintfInfo(sourceNew)

    for (let partition of EXT_PARTITIONS) {
      let halsRef = vintfRef.get(partition)?.manifest
      if (halsRef == null) {
        continue
      }

      let halsNew = vintfNew.get(partition)?.manifest ?? []

      this.log(chalk.bold(partition))

      let newAdded = diffVintfHals(halsRef, halsNew)
      let newRemoved = diffVintfHals(halsNew, halsRef)

      getHalFqNames(newRemoved).forEach(f => this.log(chalk.red(`    ${f}`)))
      if (all) {
        getHalFqNames(newAdded).forEach(f => this.log(chalk.green(`    ${f}`)))
      }

      if (outPath != undefined) {
        let outManifest = serializeVintfHals(newRemoved)
        await fs.writeFile(outPath, outManifest)
      }

      this.log()
    }
  }
}
