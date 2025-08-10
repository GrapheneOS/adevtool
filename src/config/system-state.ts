import path from 'path'
import { loadPartitionProps, PartitionProps } from '../blobs/props'
import { loadPartVintfInfo, PartitionVintfInfo } from '../blobs/vintf'
import { minimizeModules, parseModuleInfo, SoongModuleInfo } from '../build/soong-info'
import { parsePartContexts, SelinuxPartContexts } from '../selinux/contexts'
import { updateMultiMap } from '../util/data'
import { readFile } from '../util/fs'
import { ALL_SYS_PARTITIONS } from '../util/partitions'

const STATE_VERSION = 6

export interface SystemState {
  deviceInfo: {
    name: string
  }

  partitionFiles: { [part: string]: Array<string> }
  partitionProps: PartitionProps
  partitionSecontexts: SelinuxPartContexts
  partitionVintfInfo: PartitionVintfInfo

  moduleInfo: SoongModuleInfo
}

type SerializedSystemState = {
  version: number
} & SystemState

export function serializeSystemState(state: SystemState, systemRoot: string) {
  state.moduleInfo = minimizeModules(state.moduleInfo, systemRoot)

  let diskState = {
    version: STATE_VERSION,
    ...state,
  }

  return JSON.stringify(
    diskState,
    (k, v) => {
      if (v instanceof Map) {
        return {
          _type: 'Map',
          data: Object.fromEntries(v.entries()),
        }
      }
      return v
    },
    2,
  )
}

export function parseSystemState(json: string) {
  let diskState = JSON.parse(json, (k, v) => {
    // eslint-disable-next-line no-prototype-builtins
    if (v?.hasOwnProperty('_type') && v?._type == 'Map') {
      return new Map(Object.entries(v.data))
    }
    return v
  }) as SerializedSystemState

  if (diskState.version != STATE_VERSION) {
    throw new Error(`Outdated state v${diskState.version}; expected v${STATE_VERSION}`)
  }

  return diskState as SystemState
}

export async function collectSystemState(device: string, systemRoot: string) {
  let moduleInfoPath = path.join(systemRoot, 'module-info.json')
  let state = {
    deviceInfo: {
      name: device,
    },
    partitionFiles: {},
  } as SystemState

  // Files
  let fileList = await readFile(path.join(systemRoot, 'allimages-file-list.txt'))

  let topLevelDirs = new Map<string, string[]>()

  let requiredPrefix = systemRoot + '/'
  for (let filePath of fileList.split(' ')) {
    if (!filePath.startsWith(requiredPrefix)) {
      continue
    }
    let relPath = filePath.substring(requiredPrefix.length)
    let slashIdx = relPath.indexOf('/')
    if (slashIdx < 0) {
      // this is a top-level file
      continue
    }
    let dir = relPath.substring(0, slashIdx)
    updateMultiMap(topLevelDirs, dir, relPath)
  }

  for (let partition of ALL_SYS_PARTITIONS) {
    let filePaths = topLevelDirs.get(partition)
    if (filePaths !== undefined) {
      state.partitionFiles[partition] = filePaths.sort((a, b) => a.localeCompare(b))
    }
  }

  state.partitionProps = await loadPartitionProps(systemRoot)
  // SELinux contexts
  state.partitionSecontexts = await parsePartContexts(systemRoot)
  state.partitionVintfInfo = await loadPartVintfInfo(systemRoot)
  state.moduleInfo = parseModuleInfo(await readFile(moduleInfoPath))

  return state
}
