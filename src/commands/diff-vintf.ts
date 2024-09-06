import { Command } from '@oclif/command'
import { promises as fs } from 'fs'

import { diffVintfHals, getHalFqNames, loadPartVintfInfo, serializeVintfHals } from '../blobs/vintf'
import { DIFF_FLAGS, DiffList, printDiffList } from '../util/diff'
import { EXT_PARTITIONS } from '../util/partitions'

export default class DiffVintf extends Command {
  static description = 'find missing vintf declarations compared to a reference system'

  static flags = DIFF_FLAGS

  static args = [
    { name: 'sourceRef', description: 'path to root of reference system', required: true },
    { name: 'sourceNew', description: 'path to root of new system', required: true },
    { name: 'outPath', description: 'output path for manifest fragment with missing HALs' },
  ]

  async run() {
    let {
      flags: { type },
      args: { sourceRef, sourceNew, outPath },
    } = this.parse(DiffVintf)

    let vintfRef = await loadPartVintfInfo(sourceRef)
    let vintfNew = await loadPartVintfInfo(sourceNew)

    let diffs = []

    for (let partition of EXT_PARTITIONS) {
      let halsRef = vintfRef.get(partition)?.manifest
      if (halsRef == null) {
        continue
      }

      let halsNew = vintfNew.get(partition)?.manifest ?? []

      let newAdded = diffVintfHals(halsRef, halsNew)
      let newRemoved = diffVintfHals(halsNew, halsRef)

      diffs.push({
        partition,
        added: getHalFqNames(newAdded),
        removed: getHalFqNames(newRemoved),
      } as DiffList)

      if (outPath != undefined) {
        let outManifest = serializeVintfHals(newRemoved)
        await fs.writeFile(outPath, outManifest)
      }
    }

    printDiffList(diffs, type, this.log)
  }
}
