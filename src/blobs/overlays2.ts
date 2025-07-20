import assert from 'assert'
import { readFile } from 'node:fs/promises'
import path from 'path'
import { DeviceConfig } from '../config/device'
import { Filters } from '../config/filters'
import { getHostBinPath } from '../config/paths'
import { spawnAsyncStdin } from '../util/process'
import { VendorDirectories } from './build'

export async function processOverlays(config: DeviceConfig, dirs: VendorDirectories, stockSrc: string) {
  let arsclibPath = await getHostBinPath('arsclib')

  let moduleListPath = path.join(dirs.overlays, 'overlay-modules.txt')

  let cmd = {
    aapt2Path: await getHostBinPath('aapt2'),
    unpackedOsImageDir: stockSrc,
    syntheticOverlays: config.synthetic_overlays,
    pkgExclusionFilters: filtersToJson(config.filters.overlay_files),
    exclusionFilters: filtersToJson(config.filters.overlay_keys),
    inclusionFilters: filtersToJson(config.filters.overlay_inclusions),
    outDir: dirs.overlays,
    outModuleListPath: moduleListPath,
  }

  let stdin = Buffer.from(JSON.stringify(cmd), 'utf-8')
  let out = await spawnAsyncStdin(arsclibPath, ['--json-stdin'], stdin)
  console.log(out)
  return (await readFile(moduleListPath)).toString('utf-8').split('\n')
}

function filtersToJson(filters: Filters) {
  // regex filters are not supported by arsclib
  assert(filters.regex.length === 0)
  return {
    include: filters.include,
    match: Array.from(filters.match),
    prefixes: filters.prefix,
    suffixes: filters.suffix,
    substrings: filters.substring,
  }
}
