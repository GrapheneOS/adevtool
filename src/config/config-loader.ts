import _ from 'lodash'
import path from 'path'
import YAML from 'yaml'

import { readFile } from '../util/fs'
import { parseFilters, SerializedFilters } from './filters'

function mergeConfigs(base: unknown, overlay: unknown) {
  return _.mergeWith(base, overlay, (a, b) => {
    if (_.isArray(a)) {
      return a.concat(b)
    }
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadOverlaysRecursive(overlays: unknown[], rootDir: string, root: any) {
  if (_.isArray(root.includes)) {
    for (let relPath of root.includes) {
      let overlayPath = path.resolve(rootDir, relPath)
      let overlayDir = path.dirname(overlayPath)

      let overlay = YAML.parse(await readFile(overlayPath))
      await loadOverlaysRecursive(overlays, overlayDir, overlay)
    }
  }

  overlays.push(root)
}

// No dedicated parse function as this requires loading includes and overlaying
// them in the correct order
export async function loadAndMergeConfig(configPath: string, baseConfig: Readonly<object>) {
  let base = structuredClone(baseConfig) // deep copy to avoid mutating base

  let rootOverlay = YAML.parse(await readFile(configPath))
  let rootPath = path.dirname(configPath)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let overlays: any[] = []
  await loadOverlaysRecursive(overlays, rootPath, rootOverlay)

  // Merge from base to final root
  let merged = overlays.reduce((base, overlay) => mergeConfigs(base, overlay), base)

  if (merged.filters !== undefined) {
    // Parse filters
    merged.filters = Object.fromEntries(
      Object.entries(merged.filters).map(([group, filters]) => [group, parseFilters(filters as SerializedFilters)]),
    )
  }

  // Finally, cast it to the parsed config type
  delete merged.includes
  return merged
}
