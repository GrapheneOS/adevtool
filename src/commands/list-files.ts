import { Args, Command, Flags } from '@oclif/core'
import { promises as fs } from 'fs'
import { listPart } from '../blobs/file-list'

import { ALL_SYS_PARTITIONS } from '../util/partitions'
import { withWrappedSrc, WRAPPED_SOURCE_FLAGS } from '../frontend/source'

export default class ListFiles extends Command {
  static description = 'list system files and symlinks important for blobs'

  static flags = {
    help: Flags.help({ char: 'h' }),

    device: Flags.string({ char: 'd', description: 'device codename', required: true }),
    ...WRAPPED_SOURCE_FLAGS,
  }

  static args = {
    out: Args.string({
      description: 'directory to write partition file lists to',
      required: true,
    }),
  }

  async run() {
    let {
      flags: { device, stockSrc, buildId, useTemp },
      args: { out },
    } = await this.parse(ListFiles)

    await withWrappedSrc(stockSrc, device, buildId, useTemp, async stockSrc => {
      await fs.mkdir(out, { recursive: true })

      for (let partition of ALL_SYS_PARTITIONS) {
        let files = await listPart(partition, stockSrc, null, true)
        if (files == null) {
          continue
        }

        // Save results
        let outPath = `${out}/${partition}.list`
        await fs.writeFile(outPath, `${files.join('\n')}\n`)
      }
    })
  }
}
