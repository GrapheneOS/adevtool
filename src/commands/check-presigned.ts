import { Args, Command, Flags } from '@oclif/core'
import { promises as fs } from 'fs'
import chalk from 'chalk'

import { parseFileList, serializeBlobList } from '../blobs/file-list'
import { enumeratePresignedBlobs, parsePresignedRecursive, updatePresignedBlobs } from '../blobs/presigned'
import { readFile } from '../util/fs'
import { withWrappedSrc, WRAPPED_SOURCE_FLAGS } from '../frontend/source'

export default class CheckPresigned extends Command {
  static description = 'check for APKs that should be presigned'

  static flags = {
    help: Flags.help({ char: 'h' }),
    aapt2: Flags.string({
      char: 'a',
      description: 'path to aapt2 executable',
      default: 'out/host/linux-x86/bin/aapt2',
    }),
    sepolicy: Flags.string({
      char: 'p',
      description: 'paths to device and vendor sepolicy dirs',
      required: true,
      multiple: true,
    }),
    outList: Flags.string({ char: 'o', description: 'output path for new proprietary-files.txt with PRESIGNED tags' }),

    device: Flags.string({ char: 'd', description: 'device codename', required: true }),
    ...WRAPPED_SOURCE_FLAGS,
  }

  static args = {
    listPath: Args.string({
      description: 'path to LineageOS-compatible proprietary-files.txt list',
    }),
  }

  async run() {
    let { args, flags } = await this.parse(CheckPresigned)

    // Parse list
    this.log(chalk.bold(chalk.greenBright('Parsing list')))
    let listPath = args.listPath
    let list = listPath !== undefined ? await readFile(listPath) : null
    let entries = list !== null ? parseFileList(list) : null

    // Find and parse sepolicy seapp_contexts
    let presignedPkgs = await parsePresignedRecursive(flags.sepolicy)

    await withWrappedSrc(flags.stockSrc, flags.device, flags.buildId, flags.useTemp, async stockSrc => {
      if (entries != null) {
        // Get APKs from blob entries
        let presignedEntries = await updatePresignedBlobs(flags.aapt2, stockSrc, presignedPkgs, entries)
        presignedEntries.forEach(e => this.log(e.srcPath))

        if (flags.outList !== undefined) {
          let newList = serializeBlobList(presignedEntries)
          await fs.writeFile(flags.outList, newList)
        }
      } else {
        // Find APKs
        let presignedPaths = await enumeratePresignedBlobs(flags.aapt2, stockSrc, presignedPkgs)
        presignedPaths.forEach(p => this.log(p))
      }
    })
  }
}
