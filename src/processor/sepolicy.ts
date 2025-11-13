import assert from 'assert'
import { promises as fs } from 'fs'
import path from 'path'
import util from 'util'
import { VendorDirectories } from '../blobs/build'
import { DeviceConfig, getExcludedPackagesMinusBasePackages, Sepolicy } from '../config/device'
import { getHostBinPath } from '../config/paths'
import { SystemState } from '../config/system-state'
import { assertDefined, assertNonNull, updateMultiMapObj } from '../util/data'
import { EntryFilterSpec, filterEntries, FilterResult } from '../util/exact-filter'
import { readFile } from '../util/fs'
import { log } from '../util/log'
import { parseLines } from '../util/parse'
import { EXT_SYS_PARTITIONS, Partition, PathResolver, REGULAR_SYS_PARTITIONS } from '../util/partitions'
import { spawnAsync, spawnAsyncStdin } from '../util/process'
import { getRootChildren, processXml, ProcessXmlCmd, stringifyXml } from '../util/xml'
import { ApkProcessorResult } from './apk-processor'

function getSepolicyDirPath(rootOutDir: string, part: Partition, isPublic: boolean = false) {
  switch (part) {
    case Partition.SystemExt:
    case Partition.Product:
      return path.join(rootOutDir, part, isPublic ? 'public' : 'private')
    default:
      assert(!isPublic)
      return path.join(rootOutDir, part)
  }
}

const EMPTY_SEPOLICY: Sepolicy = {
  contexts: {},
  mac_permissions_entries: [],
  types: {},
  typeAttrNames: [],
  cil: [],
  recoveryOnlyPolicy: [],
  disassembled: { regular: [], recovery: [] },
}

function getPartSepolicy(map: { [part: string]: Sepolicy }, partition: string) {
  let v = map[partition]
  if (v === undefined) {
    return EMPTY_SEPOLICY
  }
  return { ...EMPTY_SEPOLICY, ...v }
}

export interface SepolicyDirs {
  dirs: { [part: string]: string }
  publicDirs: { [part: string]: string }
}

export async function processSepolicy(
  deviceConfig: DeviceConfig,
  customState: SystemState,
  pathResolver: PathResolver,
  apkProcessorResult: Promise<ApkProcessorResult>,
  dirs: VendorDirectories,
) {
  let rootOutDir = path.join(dirs.out, 'sepolicy')
  let sepolicyDirs: SepolicyDirs = {
    dirs: {},
    publicDirs: {},
  }
  let apkProcResult = await apkProcessorResult
  let excludedPackages = getExcludedPackagesMinusBasePackages(deviceConfig, apkProcResult)
  let syspropExclusions = new Set(deviceConfig.sysprop_exclusions)
  let syspropInclusions = new Set(deviceConfig.sysprop_inclusions)
  let partJobs = Array.from(EXT_SYS_PARTITIONS).map(async part => {
    let selinuxDir = getSelinuxDir(part, pathResolver)
    let exclusions = getPartSepolicy(deviceConfig.sepolicy_exclusions, part)
    let inclusions = getPartSepolicy(deviceConfig.sepolicy_inclusions, part)
    let sepolicyDirPath = getSepolicyDirPath(rootOutDir, part)
    let sepolicyPubDirPath: string | null = null
    if (part === Partition.SystemExt || part === Partition.Product) {
      sepolicyPubDirPath = getSepolicyDirPath(rootOutDir, part, true)
    }

    let customSepolicy = customState.sepolicy[part]

    let writtenAny = false
    let writtenAnyPublic = false

    let contextsJobs = (await fs.readdir(selinuxDir, { withFileTypes: true }))
      .filter(de => de.name.endsWith('_contexts'))
      .map(async de => {
        assert(de.isFile())
        let contextsFileName = de.name
        let filePath = path.join(selinuxDir, contextsFileName)

        let fileLines = parseContexts(filePath)

        let fileExclusions = new Set(
          (exclusions.contexts[contextsFileName] ?? []).concat(customSepolicy.contexts[contextsFileName] ?? []),
        )
        let fileInclusions = new Set(inclusions.contexts[contextsFileName])

        let processEntryFn: ((entry: string) => FilterResult) | undefined = undefined
        if (contextsFileName.endsWith('_seapp_contexts')) {
          processEntryFn = (entry: string) => {
            for (let part of entry.split(' ')) {
              let prefix = 'name='
              if (part.startsWith(prefix)) {
                let token = part.substring(prefix.length)
                let processSeparator = token.indexOf(':')
                let name = processSeparator > 0 ? token.substring(0, processSeparator) : token
                if (excludedPackages.has(name) || !apkProcResult.allPackageNames.has(name)) {
                  return FilterResult.EXCLUDE
                } else {
                  break
                }
              }
            }
            return FilterResult.UNKNOWN_ENTRY
          }
        } else if (contextsFileName.endsWith('_property_contexts')) {
          processEntryFn = (entry: string) => {
            let splitIdx = entry.indexOf(' ')
            assert(splitIdx > 0)
            let prop = entry.substring(0, splitIdx)
            if (syspropExclusions.has(prop)) {
              return FilterResult.EXCLUDE
            }
            if (syspropInclusions.has(prop)) {
              return FilterResult.INCLUDE
            }
            return FilterResult.UNKNOWN_ENTRY
          }
        }

        let filteredLines = filterEntries({
          process: processEntryFn,
          entries: await fileLines,
          exclusions: fileExclusions,
          inclusions: fileInclusions,
          unknownEntriesMessagePrefix: 'included unknown ' + contextsFileName + ':',
          yamlPath: ['', part, 'contexts', contextsFileName],
        })

        if (filteredLines.length > 0) {
          await fs.mkdir(sepolicyDirPath, { recursive: true })
          let name = contextsFileName
          let prefix = fileNamePrefix(part)
          if (name.startsWith(prefix + '_')) {
            name = name.slice(prefix.length + 1)
          }
          await fs.writeFile(path.join(sepolicyDirPath, name), filteredLines.join('\n'))
          writtenAny = true
        }
      })

    let typesJob = (async () => {
      let parsedCil = await parseCil(selinuxDir, part)
      let customTypeAttrs = customSepolicy.types
      let typeLines: string[] = []
      let definedAttrs = new Set<string>(
        customSepolicy.typeAttrNames.concat(...customState.sepolicy[Partition.System].typeAttrNames),
      )
      for (let [type, attrs] of Object.entries(parsedCil.typeAttrs)) {
        for (let attr of attrs) {
          if (!definedAttrs.has(attr)) {
            typeLines.push('attribute ' + attr + ';')
            definedAttrs.add(attr)
          }
        }
        let customAttrs = customTypeAttrs[type]
        if (customAttrs === undefined) {
          typeLines.push('type ' + type + (attrs.length > 0 ? ', ' + attrs.join(', ') : '') + ';')
        } else {
          let set = new Set(attrs)
          customAttrs.forEach(a => set.delete(a))
          for (let a of set) {
            typeLines.push('typeattribute ' + type + ' ' + a + ';')
          }
        }
      }
      for (let attr of parsedCil.typeAttrNames) {
        if (!definedAttrs.has(attr)) {
          typeLines.push('attribute ' + attr + ';')
          definedAttrs.add(attr)
        }
      }
      let cilLines = renameBaseTypeattrs(parsedCil)

      let customCilLines = new Set<string>(customSepolicy.cil)

      let cil = cilLines.filter(l => !customCilLines.has(l)).join('\n')

      let writes: Promise<void>[] = []
      if (typeLines.length > 0) {
        let dirPath = sepolicyPubDirPath !== null ? sepolicyPubDirPath : sepolicyDirPath
        let filePath = path.join(dirPath, 'types.te')
        writes.push(
          (async () => {
            await fs.mkdir(dirPath, { recursive: true })
            await fs.writeFile(filePath, typeLines.join('\n'))
            if (dirPath === sepolicyPubDirPath) {
              writtenAnyPublic = true
            }
          })(),
        )
      }
      if (cil.length > 0) {
        let filePath = path.join(sepolicyDirPath, 'sepolicy_ext.cil')
        writes.push(
          (async () => {
            await fs.mkdir(sepolicyDirPath, { recursive: true })
            await fs.writeFile(filePath, cil)
            writtenAny = true
          })(),
        )
      }
      await Promise.all(writes)
    })()

    let sepolicyExtJob = (async () => {
      if (part !== Partition.Vendor) {
        return
      }
      let disassembled = await disassemblePolicy(pathResolver)
      let custom = assertDefined(customSepolicy.disassembled)
      let customRecovery = new Set(custom.recovery)
      let recoveryBody = disassembled.recovery.filter(e => !customRecovery.has(e)).join('\n')
      let recovery = 'recovery_only(`\n' + recoveryBody + "\n')"
      await fs.mkdir(sepolicyDirPath, { recursive: true })
      await fs.writeFile(path.join(sepolicyDirPath, 'recovery_sepolicy_ext.te'), recovery)
    })()

    let macPermsJob = (async () => {
      let macPermissionsExclusions = new Set(
        exclusions.mac_permissions_entries.concat(customSepolicy.mac_permissions_entries ?? []),
      )
      let macPermissionsInclusions = new Set(inclusions.mac_permissions_entries)

      let cmd = {
        xmlFilePath: path.join(selinuxDir, fileNamePrefix(part) + '_mac_permissions.xml'),
        allowedRootElementNames: ['policy'],
        rootElementPrefilter: PLATFORM_SEINFO_FILTER,
        dstDirPath: sepolicyDirPath,
        dstFileName: 'mac_permissions.xml',
        dstFileHeader: '<?xml version="1.0" encoding="iso-8859-1"?>\n',
        filterSpec: {
          exclusions: macPermissionsExclusions,
          inclusions: macPermissionsInclusions,
          unknownEntriesMessagePrefix: 'included unknown mac_permissions entries:',
          yamlPath: ['', part, 'mac_permissions_entries'],
        } as EntryFilterSpec,
      } as ProcessXmlCmd
      writtenAny ||= (await processXml(cmd)).length > 0
    })()

    await Promise.all(contextsJobs.concat(...[macPermsJob, typesJob, sepolicyExtJob]))

    let actions: (() => void)[] = []
    if (writtenAny) {
      actions.push(() => (sepolicyDirs.dirs[part] = sepolicyDirPath))
    }
    if (writtenAnyPublic) {
      actions.push(() => (sepolicyDirs.publicDirs[part] = assertNonNull(sepolicyPubDirPath)))
    }
    return actions
  })
  let actions = await Promise.all(partJobs)
  // make sepolicy dir order deterministic
  actions.forEach(arr => arr.forEach(action => action()))
  return sepolicyDirs
}

const PLATFORM_SEINFO_FILTER = (el: Record<string, unknown>) => {
  for (let child of el.signer as Record<string, unknown>[]) {
    if (child.seinfo !== undefined) {
      let seinfo = assertDefined((child[':@'] as Record<string, string>)['@_value'])
      if (seinfo === 'platform') {
        return false
      }
    }
  }
  return true
}

interface ParsedCil {
  types: string[]
  typeAttrNames: string[]
  typeAttrs: { [type: string]: string[] }
  otherExprs: unknown[][]
  allExprs: unknown[]
}

function fileNamePrefix(part: Partition) {
  return part === Partition.System ? 'plat' : part
}

async function parseCil(selinuxDir: string, part: Partition) {
  let parser = await require('s-expression')
  let cilFilePath = path.join(selinuxDir, fileNamePrefix(part) + '_sepolicy.cil')
  let typeattrExprs: unknown[][] = []
  let otherExprs: unknown[][] = []
  let allExprs: unknown[][] = []
  let types: string[] = []
  let typeAttrNames: string[] = []
  for (let line of (await readFile(cilFilePath)).split('\n')) {
    if (line.length == 0 || line.startsWith(';')) {
      continue
    }
    let expr = parser(line) as string[]
    assert(expr !== undefined, line)
    allExprs.push(expr)
    stringifySexpr(expr, null)
    switch (expr[0]) {
      case 'type':
        assert(expr.length === 2)
        types.push(expr[1])
        break
      case 'typeattributeset': {
        assert(expr.length === 3)
        let attr = expr[1]
        if (attr.startsWith('base_typeattr_')) {
          otherExprs.push(expr)
        } else {
          typeattrExprs.push(expr)
        }
        break
      }
      case 'typeattribute': {
        assert(expr.length === 2)
        let name = expr[1]
        if (!name.startsWith('base_typeattr_')) {
          typeAttrNames.push(name)
        } else {
          otherExprs.push(expr)
        }
        break
      }
      case 'roletype':
        assert(expr.length === 3)
        continue
      case 'neverallow':
      case 'expandtypeattribute':
        continue
      default:
        otherExprs.push(expr)
        break
    }
  }

  let typesSet = new Set<string>(types)

  let typeAttrs: { [name: string]: string[] } = {}

  for (let type of types) {
    typeAttrs[type] = []
  }

  for (let expr of typeattrExprs) {
    let attr = expr[1] as string
    if (attr.startsWith('base_typeattr_')) {
      continue
    }
    assert(Array.isArray(expr[2]))
    for (let domain of expr[2]) {
      if (!typesSet.has(domain)) {
        continue
      }
      updateMultiMapObj(typeAttrs, domain, attr)
    }
  }

  return { types, typeAttrNames, typeAttrs, otherExprs, allExprs } as ParsedCil
}

function getSelinuxDir(part: Partition, pathResolver: PathResolver) {
  return pathResolver.resolve(part, 'etc/selinux')
}

export async function loadSepolicy(pathResolver: PathResolver) {
  let partJobs = Array.from(REGULAR_SYS_PARTITIONS).map(async part => {
    let selinuxDir = getSelinuxDir(part, pathResolver)
    let contextsJob = (await fs.readdir(selinuxDir, { withFileTypes: true }))
      .filter(de => de.name.endsWith('_contexts'))
      .map(async de => {
        assert(de.isFile())
        let contextsFileName = de.name
        let filePath = path.join(selinuxDir, contextsFileName)

        return [contextsFileName, await parseContexts(filePath)]
      })

    let macPermsJob = (async () => {
      let name = fileNamePrefix(part) + '_mac_permissions.xml'
      let filePath = path.join(selinuxDir, name)
      return getRootChildren(await readFile(filePath), ['policy'])
        .rootChildren.filter(e => PLATFORM_SEINFO_FILTER(e as Record<string, unknown>))
        .map(el => stringifyXml([el]))
    })()

    let parsedCilJob = parseCil(selinuxDir, part)

    let contextsArr = (await Promise.all(contextsJob)) as [string, string[]][]
    let contexts: { [fileName: string]: string[] } = {}
    for (let [fileName, fileLines] of contextsArr) {
      contexts[fileName] = fileLines
    }
    let parsedCil = await parsedCilJob

    let disassembled = part === Partition.Vendor ? await disassemblePolicy(pathResolver) : undefined

    let config = {
      types: parsedCil.typeAttrs,
      typeAttrNames: parsedCil.typeAttrNames,
      cil: parsedCil.allExprs.map(e => stringifySexpr(e as unknown[], null)),
      contexts,
      mac_permissions_entries: await macPermsJob,
      disassembled,
    } as Sepolicy
    return [part, config]
  })
  let partState = (await Promise.all(partJobs)) as [Partition, Sepolicy][]
  let res: { [part: string]: Sepolicy } = {}
  for (let [part, config] of partState) {
    res[part as string] = config
  }
  return res
}

export interface DisassembledSepolicy {
  regular: string[] | null
  recovery: string[]
}

async function disassemblePolicy(pathResolver: PathResolver) {
  let [regular, recovery] = await Promise.all([
    disassemblePolicyFile(path.join(getSelinuxDir(Partition.Vendor, pathResolver), 'precompiled_sepolicy')),
    disassemblePolicyFile(pathResolver.resolve(Partition.Recovery, 'sepolicy')),
  ])

  let regularSet = new Set(regular)
  recovery = recovery.filter(e => !regularSet.has(e))
  // regular.sort()
  recovery.sort()
  return { regular: null, recovery } as DisassembledSepolicy
}

async function disassemblePolicyFile(filePath: string) {
  // return (await spawnAsync(await getHostBinPath('dispol'), ['-a', 'A1F', filePath]))
  return (await spawnAsync(await getHostBinPath('dispol'), ['-a', '1F', filePath]))
    .split('\n')
    .filter(l => l !== '' && l !== 'filename_trans rules:')
    .map(l => l.trim())
}

async function parseContexts(filePath: string) {
  let file = await readFile(filePath)
  return Array.from(parseLines(file)).map(line => line.replaceAll(/\s+/g, ' '))
}

export async function getCertDigests(apkPaths: string[], sdkVersion: string) {
  let stdout = await spawnAsyncStdin(
    await getHostBinPath('apksigner'),
    ['print-certs', '--min-sdk-version', sdkVersion, '--max-sdk-version', sdkVersion],
    Buffer.from(apkPaths.join('\n'), 'utf-8'),
  )
  let res = stdout.split('\n')
  assert(res.length === apkPaths.length)

  let map = new Map<string, string>()
  for (let i = 0; i < apkPaths.length; ++i) {
    map.set(apkPaths[i], res[i])
  }
  return map
}

function renameBaseTypeattrs(cil: ParsedCil) {
  let map = new Map<string, string>()

  let index = 0

  for (let expr of cil.otherExprs) {
    if (expr[0] === 'typeattribute') {
      assert(expr.length === 2)
      let name = expr[1] as string
      // assert(name.startsWith('base_typeattr_'))
      if (!name.startsWith('base_typeattr_')) {
        log('unexpected attr: ' + util.inspect(expr, false, 100))
        continue
      }
      assert(!map.has(name))
      map.set(name, 'base_adevtool_typeattr_' + index)
      index += 1
    }
  }

  return cil.otherExprs.map(e => stringifySexpr(e, map))
}

function stringifySexpr(obj: unknown[], map: Map<string, string> | null) {
  let s = '('
  let first = true
  for (let entry of obj) {
    if (!first) {
      s += ' '
    }
    if (Array.isArray(entry)) {
      s += stringifySexpr(entry, map)
    } else {
      let entryStr = entry as string
      if (map !== null) {
        let mapped = map.get(entryStr)
        if (mapped !== undefined) {
          entryStr = mapped
        }
      }
      s += entryStr
    }
    first = false
  }
  s += ')'
  return s
}
