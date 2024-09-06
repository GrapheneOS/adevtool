import { Command, flags } from '@oclif/command'

import { diffPartitionProps, loadPartitionProps, PartitionProps } from '../blobs/props'
import { DIFF_FLAGS, DiffMap, printDiffMap } from '../util/diff'

const BUILD_KEY_PATTERN = /^ro(?:\.(?:system|system_ext|product|vendor|odm|vendor_dlkm|odm_dlkm))?\.build\..+$/

function removeBuildProps(partProps: PartitionProps) {
  for (let props of partProps.values()) {
    for (let key of props.keys()) {
      if (key.match(BUILD_KEY_PATTERN)) {
        props.delete(key)
      }
    }
  }
}

export default class DiffProps extends Command {
  static description = 'find missing and different properties compared to a reference system'

  static flags = {
    includeBuild: flags.boolean({ char: 'b', description: 'include build props', default: false }),
    ...DIFF_FLAGS
  }

  static args = [
    { name: 'sourceRef', description: 'path to root of reference system', required: true },
    { name: 'sourceNew', description: 'path to root of new system', required: true },
  ]

  async run() {
    let {
      flags: { type, includeBuild },
      args: { sourceRef, sourceNew },
    } = this.parse(DiffProps)

    let propsRef = await loadPartitionProps(sourceRef)
    let propsNew = await loadPartitionProps(sourceNew)

    // Remove build props?
    if (!includeBuild) {
      removeBuildProps(propsRef)
      removeBuildProps(propsNew)
    }

    let partChanges = diffPartitionProps(propsRef, propsNew)

    let diffs = []

    for (let [partition, changes] of partChanges.entries()) {
      diffs.push({
        partition,
        ...changes
      } as DiffMap)
    }

    printDiffMap(diffs, type, this.log)
  }
}
