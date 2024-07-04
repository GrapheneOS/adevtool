import assert from 'assert'
import { promises as fs } from 'fs'
import hasha from 'hasha'
import path from 'path'
import YAML from 'yaml'

import { yamlStringifyNoFold } from './yaml'

// FileTreeSpec is a data structure for verifying and comparing all files in a directory.
// FileTreeSpec maps file path to:
// - SHA-256 hash if file is a regular file
// - DIR_SPEC_PLACEHOLDER value if file is a directory
//
// Other file types are not supported.
export type FileTreeSpec = Map<string, string>

export const DIR_SPEC_PLACEHOLDER = 'dir'

export async function getFileTreeSpec(dir: string) {
  let res: FileTreeSpec = new Map<string, string>()
  await getFileTreeSpecStep(dir, dir, res)
  return res
}

export function fileTreeSpecToYaml(fth: FileTreeSpec) {
  return yamlStringifyNoFold(new Map([...fth.entries()].sort()))
}

export function parseFileTreeSpecYaml(yamlStr: string) {
  return YAML.parse(yamlStr, { mapAsMap: true }) as FileTreeSpec
}

async function getFileTreeSpecStep(baseDir: string, dir: string, dst: FileTreeSpec) {
  let dirents = await fs.readdir(dir, { withFileTypes: true })
  let promises: Promise<void>[] = []
  for (const dirent of dirents) {
    let dePath = path.join(dir, dirent.name)
    if (dirent.isDirectory()) {
      dst.set(path.relative(baseDir, dePath), DIR_SPEC_PLACEHOLDER)
      promises.push(getFileTreeSpecStep(baseDir, dePath, dst))
    } else if (dirent.isFile()) {
      promises.push(hashFile(baseDir, dePath, dst))
    } else {
      throw new Error('unexpected Dirent type ' + dirent)
    }
  }

  await Promise.all(promises)
}

async function hashFile(baseDir: string, filePath: string, dst: FileTreeSpec) {
  let hash = await hasha.fromFile(filePath, { algorithm: 'sha256' })
  dst.set(path.relative(baseDir, filePath), hash)
}

export class FileTreeComparison {
  constructor(
    readonly a: FileTreeSpec,
    readonly b: FileTreeSpec,
  ) {}

  // present in B, but missing in A
  readonly newEntries = new Map<string, string>()
  // present in A, but missing in B
  readonly missingEntries = new Map<string, string>()
  readonly changedEntries: string[] = []

  numDiffs() {
    return this.newEntries.size + this.missingEntries.size + this.changedEntries.length
  }

  static async get(a: FileTreeSpec, b: FileTreeSpec) {
    let allPaths = new Set([...a.keys(), ...b.keys()])

    let res = new FileTreeComparison(a, b)

    for (let entry of allPaths) {
      let valA = a.get(entry)
      let valB = b.get(entry)

      if (valA === valB) {
        continue
      }
      if (valA === undefined) {
        assert(valB !== undefined)
        res.newEntries.set(entry, valB)
      } else if (valB === undefined) {
        res.missingEntries.set(entry, valA)
      } else {
        res.changedEntries.push(entry)
      }
    }

    return res
  }
}
