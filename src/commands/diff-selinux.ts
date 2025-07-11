import { Args, Command, Flags } from '@oclif/core'
import { promises as fs } from 'fs'
import chalk from 'chalk'
import path from 'path'

import { exists, listFilesRecursive, readFile } from '../util/fs'
import { parseLines } from '../util/parse'
import { EXT_PARTITIONS } from '../util/partitions'

function shouldIgnoreSelinuxFile(filename: string): boolean {
  return filename.endsWith('.xml') ||
         filename.endsWith('.sha512') ||
         filename.endsWith('.txt') ||
         filename === 'precompiled_sepolicy' ||
         filename === 'selinux_denial_metadata'
}

function normalizeSelinuxContent(content: string): string {
  return content
    .trim()
    .split('\n')
    .filter(line => {
      const trimmedLine = line.trim()
      return !trimmedLine.startsWith('(typeattributeset base_typeattr_') &&
             !trimmedLine.startsWith('(typeattribute base_typeattr_') &&
             !trimmedLine.startsWith('(neverallow')
    })
    .join('\n')
    .replaceAll(/\s+/g, ' ')
    .replace(/_20\d{4,}/g, '_DATE') // Avoids diffs for dates only.
}

async function parseSelinuxFile(filePath: string): Promise<string[]> {
  if (!(await exists(filePath))) {
    return []
  }

  const content = await readFile(filePath)
  return Array.from(parseLines(content))
    .map(line => normalizeSelinuxContent(line))
    .filter(line => line.length > 0)
    .sort()
}

async function loadPartitionSelinuxFiles(root: string, partition: string): Promise<Map<string, string[]>> {
  const files = new Map<string, string[]>()
  const sepolicyDir = `${root}/${partition}/etc/selinux`
  
  if (!(await exists(sepolicyDir))) {
    return files
  }

  for await (const file of listFilesRecursive(sepolicyDir)) {
    const filename = path.basename(file)
    if (shouldIgnoreSelinuxFile(filename)) {
      continue
    }
    files.set(filename, await parseSelinuxFile(file))
  }

  return files
}

function diffStringArrays(ref: string[], new_: string[]): { added: string[], removed: string[] } {
  const refSet = new Set(ref)
  const newSet = new Set(new_)
  
  return {
    added: new_.filter(line => !refSet.has(line)),
    removed: ref.filter(line => !newSet.has(line))
  }
}

export default class DiffSelinux extends Command {
  static description = 'find missing selinux policies and contexts compared to a reference system'

  static flags = {
    help: Flags.help({ char: 'h' }),
    all: Flags.boolean({
      char: 'a',
      description: 'show all differences, not only missing/removed items',
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
      description: 'output path for file with missing items',
    }),
  }

  async run() {
    let {
      flags: { all },
      args: { sourceRef, sourceNew, outPath },
    } = await this.parse(DiffSelinux)

    let allMissing: string[] = []

    for (let partition of EXT_PARTITIONS) {
      let filesRef = await loadPartitionSelinuxFiles(sourceRef, partition)
      let filesNew = await loadPartitionSelinuxFiles(sourceNew, partition)

      if (filesRef.size === 0 && filesNew.size === 0) {
        continue
      }

      this.log(chalk.bold(partition))

      let allFilenames = new Set([...filesRef.keys(), ...filesNew.keys()])

      for (let filename of allFilenames) {
        let refLines = filesRef.get(filename) ?? []
        let newLines = filesNew.get(filename) ?? []
        let { added, removed } = diffStringArrays(refLines, newLines)

        if (removed.length > 0) {
          this.log(chalk.cyan(`  ${filename} (removed):`))
          removed.forEach(line => this.log(chalk.red(`    ${line}`)))
        }

        if (all && added.length > 0) {
          this.log(chalk.cyan(`  ${filename} (added):`))
          added.forEach(line => {
            this.log(chalk.green(`    ${line}`))
            allMissing.push(`${partition}/${filename}: ${line}`)
          })
        }
      }

      this.log()
    }

    if (outPath != undefined && allMissing.length > 0) {
      await fs.writeFile(outPath, allMissing.join('\n') + '\n')
    }
  }
} 