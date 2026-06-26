import assert from 'assert'
import { Partition } from './partitions'
import { stringifyXml } from './xml'
import { log } from './log'

export function getExclusions(
  config: { [part: string]: string[] },
  customState: Map<string, string[]>,
  part: Partition,
) {
  return new Set<string>((config[part] ?? []).concat(customState.get(part) ?? []))
}

export function getInclusions(config: { [part: string]: string[] }, part: Partition) {
  return new Set<string>(config[part])
}

export interface EntryFilterSpecBase {
  exclusions: Set<string>
  inclusions: Set<string>
  unknownEntriesMessagePrefix: string
  unknownEntryDisplayMapper?: (entry: string) => string
  yamlPath: string[]
}

export type EntryFilterSpec = {
  process?: (entry: string) => FilterResult
} & EntryFilterSpecBase

export type EntryFilterCmd = {
  entries: Iterable<string>
} & EntryFilterSpec

export function filterEntries(cmd: EntryFilterCmd) {
  let unknownEntries: string[] = []
  let filtered = Array.from(cmd.entries).filter(entry => {
    if (cmd.exclusions.has(entry)) {
      return false
    }
    if (cmd.inclusions.has(entry)) {
      return true
    }
    if (cmd.process !== undefined) {
      switch (cmd.process(entry)) {
        case FilterResult.EXCLUDE:
          return false
        case FilterResult.INCLUDE:
          return true
        case FilterResult.UNKNOWN_ENTRY:
          unknownEntries.push(entry)
          return true
      }
    } else {
      unknownEntries.push(entry)
    }
    return true
  })
  if (unknownEntries.length > 0) {
    printUnknownEntries(cmd, unknownEntries)
  }
  return filtered
}

export enum FilterResult {
  EXCLUDE,
  UNKNOWN_ENTRY,
  INCLUDE,
}

export type EntryFilter2Spec<T> = {
  preprocess?: (entry: T) => T | null
  process?: (entryStr: string, entry: T) => FilterResult | T
} & EntryFilterSpecBase

export type EntryFilter2Cmd<T> = {
  entries: Iterable<[string, T]>
} & EntryFilter2Spec<T>

interface FilterEntries2Result<T> {
  entries: [string, T][]
  hasTransforms: boolean
}

export function filterEntries2<T extends Record<string, unknown>>(cmd: EntryFilter2Cmd<T>) {
  let unknownEntries: string[] = []
  let filtered: [string, T][] = []
  let hasTransforms = false
  for (let pair of Array.from(cmd.entries)) {
    // system_ext/etc/sysconfig/preinstalled-packages-cccdktimesync.xml has an invalid extra dot after comment as of CP2A.260605.012
    if (pair[1]['#text'] === '.' && Object.keys(pair[1]).length === 1) {
      continue
    }
    if (cmd.preprocess !== undefined) {
      let res = cmd.preprocess(pair[1])
      if (res !== null) {
        pair = [stringifyXml([res]), res]
        hasTransforms = true
      }
    }
    let entryStr = pair[0]
    if (cmd.exclusions.has(entryStr)) {
      continue
    }
    if (cmd.inclusions.has(entryStr)) {
      filtered.push(pair)
      continue
    }
    if (cmd.process !== undefined) {
      let res = cmd.process(entryStr, pair[1])
      switch (res) {
        case FilterResult.EXCLUDE:
          break
        case FilterResult.INCLUDE:
          filtered.push(pair)
          break
        case FilterResult.UNKNOWN_ENTRY:
          unknownEntries.push(entryStr)
          filtered.push(pair)
          break
        default: {
          assert(res, entryStr)
          let filteredPair = [stringifyXml([res]), res] as [string, T]
          filtered.push(filteredPair)
          hasTransforms = true
        }
      }
    } else {
      filtered.push(pair)
      unknownEntries.push(entryStr)
    }
  }
  if (unknownEntries.length > 0) {
    printUnknownEntries(cmd, unknownEntries)
  }
  return { entries: filtered, hasTransforms } as FilterEntries2Result<T>
}

export function printUnknownEntries(cmd: EntryFilterSpecBase, entries: string[]) {
  let str = cmd.unknownEntriesMessagePrefix + '\n'
  let prefix = ''
  for (let i = 0; i < cmd.yamlPath.length; ++i) {
    let item = cmd.yamlPath[i]
    if (item.length > 0) {
      str += prefix + item + ':\n'
    }
    prefix += '  '
  }

  for (let entry of entries.sort()) {
    if (cmd.unknownEntryDisplayMapper !== undefined) {
      entry = cmd.unknownEntryDisplayMapper(entry)
    }
    let lines = entry.split('\n')
    if (lines.length > 1) {
      str += prefix + '- |-\n'
      let linePrefix = prefix + '  '
      for (let line of lines) {
        str += linePrefix + line + '\n'
      }
    } else {
      assert(lines.length === 1)
      str += prefix + '- ' + lines[0] + '\n'
    }
  }
  log(str)
}
