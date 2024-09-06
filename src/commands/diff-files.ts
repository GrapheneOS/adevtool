import { Command } from '@oclif/command'

import { diffLists, listPart } from '../blobs/file-list'
import { DIFF_FLAGS, DiffList, printDiffList } from '../util/diff'
import { ALL_SYS_PARTITIONS } from '../util/partitions'

export default class DiffFiles extends Command {
  static description = 'find missing system files compared to a reference system'

  static flags = DIFF_FLAGS

  static args = [
    { name: 'sourceRef', description: 'path to root of reference system', required: true },
    { name: 'sourceNew', description: 'path to root of new system', required: true },
  ]

  async run() {
    let {
      flags: { type },
      args: { sourceRef, sourceNew },
    } = this.parse(DiffFiles)

    let diffs = []

    for (let partition of ALL_SYS_PARTITIONS) {
      let filesRef = await listPart(partition, sourceRef)
      if (filesRef == null) {
        continue
      }

      let filesNew = (await listPart(partition, sourceNew)) ?? []

      diffs.push({
        partition,
        added: diffLists(filesRef, filesNew),
        removed: diffLists(filesNew, filesRef),
      } as DiffList)
    }

    printDiffList(diffs, type, this.log)
  }
}
