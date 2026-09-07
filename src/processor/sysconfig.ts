import assert from 'assert'
import { promises as fs } from 'fs'
import path from 'path'
import { VendorDirectories } from '../blobs/build'
import { appendPartitionProps, serializeBlueprint, SoongModule } from '../build/soong'
import { DeviceConfig, getExcludedPackagesMinusBasePackages, getPackagePermsConfig } from '../config/device'
import { SystemState } from '../config/system-state'
import { assertDefined, updateMultiMap } from '../util/data'
import { FilterResult } from '../util/exact-filter'
import { isDirectory } from '../util/fs'
import { log } from '../util/log'
import { ALL_SYS_PARTITIONS, Partition, PathResolver } from '../util/partitions'
import { getRootChildren, processXml, ProcessXmlCmd, stringifyXml } from '../util/xml'
import { ApkProcessorResult } from './apk-processor'

export const SYSCONFIG_DIR_NAMES = [
  'default-permissions', // technically not sysconfig, but handled the same way
  'sysconfig',
  'permissions', // legacy alias for sysconfig dir
]

export interface SysconfigXmlFile {
  partition?: Partition
  dirName: string
  path: string
}

export interface GetSysconfigXmlFilesOptions {
  dirNames?: readonly string[]
  partitions?: readonly Partition[]
  partitionSubdirs?: Partial<Record<Partition, readonly string[]>>
  platformLast?: boolean
}

function sortSysconfigXmlFileNames(names: string[], platformLast: boolean) {
  names.sort()
  if (!platformLast) {
    return names
  }
  return names.filter(n => n !== 'platform.xml').concat(names.filter(n => n === 'platform.xml'))
}

async function getXmlFilesInSysconfigDir(
  dirPath: string,
  dirName: string,
  partition: Partition | undefined,
  platformLast: boolean,
): Promise<SysconfigXmlFile[]> {
  if (!(await isDirectory(dirPath))) {
    return []
  }
  let names = (await fs.readdir(dirPath, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.xml'))
    .map(entry => entry.name)

  return sortSysconfigXmlFileNames(names, platformLast).map(name => ({
    partition,
    dirName,
    path: path.join(dirPath, name),
  }))
}

export async function getSysconfigXmlFiles(
  pathResolver: PathResolver,
  options: GetSysconfigXmlFilesOptions = {},
): Promise<SysconfigXmlFile[]> {
  let dirNames = options.dirNames ?? SYSCONFIG_DIR_NAMES
  let partitions = options.partitions ?? Array.from(ALL_SYS_PARTITIONS)
  let platformLast = options.platformLast ?? false

  let partJobs = partitions.map(async partition => {
    let dirJobs = dirNames.map(async dirName => {
      let dirPath = pathResolver.resolve(partition, path.join('etc', dirName))
      return getXmlFilesInSysconfigDir(dirPath, dirName, partition, platformLast)
    })
    let files = (await Promise.all(dirJobs)).flat()
    let subdirs = options.partitionSubdirs?.[partition] ?? []
    for (let subdir of subdirs) {
      let subdirJobs = dirNames.map(async dirName => {
        let dirPath = pathResolver.resolve(partition, path.join('etc', dirName, subdir))
        return getXmlFilesInSysconfigDir(dirPath, dirName, partition, platformLast)
      })
      files.push(...(await Promise.all(subdirJobs)).flat())
    }
    return files
  })
  let files = (await Promise.all(partJobs)).flat()

  return files
}

interface PartitionSysconfig {
  partition: Partition
  sysconfigDirs: SysconfigDir[]
}

interface SysconfigDir {
  dirPath: string
  filePaths: string[]
}

export async function processSysconfig(
  deviceConfig: DeviceConfig,
  pathResolver: PathResolver,
  apkProcessorResult: Promise<ApkProcessorResult>,
  customState: SystemState,
  dirs: VendorDirectories,
) {
  let rootOutDir = path.join(dirs.out, 'sysconfig')
  let apkProcResult = await apkProcessorResult
  let excludedPackages = getExcludedPackagesMinusBasePackages(deviceConfig, apkProcResult)

  let exclusions = new Set(deviceConfig.sysconfig_exclusions.concat(customState.sysConfigs))
  let inclusions = new Set(deviceConfig.sysconfig_inclusions)

  let partJobs = Array.from(ALL_SYS_PARTITIONS).map(async partition => {
    let dirJobs = SYSCONFIG_DIR_NAMES.map(async sysconfigDirName => {
      let partSysconfigDirRelPath = path.join('etc', sysconfigDirName)
      let partSysconfigDirPath = pathResolver.resolve(partition, partSysconfigDirRelPath)
      if (!(await isDirectory(partSysconfigDirPath))) {
        return null
      }
      let sysconfigSubDirs = new Map<string, string[]>()
      for (let de of await fs.readdir(partSysconfigDirPath, { withFileTypes: true, recursive: true })) {
        if (de.isDirectory()) {
          continue
        }
        assert(de.isFile(), de.name)
        updateMultiMap(sysconfigSubDirs, de.parentPath, de.name)
      }

      let sysconfigSubDirJobs: Promise<SysconfigDir>[] = Array.from(sysconfigSubDirs.entries()).map(
        async ([sysConfigDirPath, sysConfigNames]) => {
          let dstDirPath = path.join(
            rootOutDir,
            partition,
            sysconfigDirName,
            path.relative(partSysconfigDirPath, sysConfigDirPath),
          )
          let fileJobs = sysConfigNames.map(async sysConfigFileName => {
            let xmlFilePath = path.join(sysConfigDirPath, sysConfigFileName)

            let dstFileName = sysConfigFileName
            if (dstFileName.endsWith(`-merged-${partition}.xml`)) {
              // '-merged-${partition}.xml' files are generated by the build system, rename them
              // to avoid conflicts
              dstFileName = dstFileName.slice(0, -'.xml'.length) + '-stock.xml'
            }

            let cmd = {
              xmlFilePath,
              allowedRootElementNames: ['config', 'permissions', 'exceptions'],
              dstDirPath,
              dstFileName,
              filterSpec: {
                preprocess(entry) {
                  let attrs = entry[':@']
                  if (attrs === undefined) {
                    return null
                  }
                  const packageAttr = '@_package'
                  let pkgName = (attrs as Record<string, string>)[packageAttr]
                  if (pkgName === undefined) {
                    return null
                  }

                  let mappedPkgName = apkProcResult.packageNameMapping.get(pkgName)
                  if (mappedPkgName === undefined) {
                    return null
                  }
                  let clonedEntry = structuredClone(entry)
                  let clonedAttrs = clonedEntry[':@'] as Record<string, string>
                  clonedAttrs[packageAttr] = mappedPkgName
                  return clonedEntry
                },
                process: (_, entry) => {
                  let attrs = entry[':@']
                  if (attrs === undefined) {
                    return FilterResult.UNKNOWN_ENTRY
                  }
                  const packageAttr = '@_package'
                  let pkgName = (attrs as Record<string, string>)[packageAttr]
                  if (pkgName === undefined) {
                    return FilterResult.UNKNOWN_ENTRY
                  }

                  if (excludedPackages.has(pkgName)) {
                    return FilterResult.EXCLUDE
                  }

                  if (!apkProcResult.allPackageNames.has(pkgName)) {
                    return FilterResult.EXCLUDE
                  }

                  let inclusionConfig = deviceConfig.package_inclusions[pkgName]

                  let elementName = Object.keys(entry)[0]
                  switch (elementName) {
                    case 'exception':
                    case 'privapp-permissions': {
                      if (inclusionConfig === undefined) {
                        return FilterResult.UNKNOWN_ENTRY
                      }
                      let ppc = getPackagePermsConfig(inclusionConfig)
                      let unknownPerms: string[] = []
                      let origChildren = entry[elementName] as Record<string, unknown>[]
                      let filteredChildren = origChildren.filter(child => {
                        let keys = Object.keys(child)
                        assert(keys.length === 2)
                        assert(keys[0] === 'permission')
                        assert(keys[1] === ':@')
                        let childAttrs = child[':@'] as Record<string, string>
                        let permName = assertDefined(childAttrs['@_name'])
                        if (ppc.removePerms.has(permName)) {
                          return false
                        }
                        if (ppc.pregrantablePerms.has(permName)) {
                          return true
                        }
                        unknownPerms.push(permName)
                        return true
                      })
                      if (unknownPerms.length > 0) {
                        unknownPerms.sort()
                        log(pkgName + ': included unknown sysconfig ' + elementName + ' entries:')
                        for (let p of unknownPerms) {
                          log('      - ' + p)
                        }
                      }
                      if (filteredChildren.length === 0) {
                        return FilterResult.EXCLUDE
                      }
                      if (origChildren.length === filteredChildren.length) {
                        return FilterResult.INCLUDE
                      }
                      let res = structuredClone(entry)
                      res[elementName] = structuredClone(filteredChildren)
                      return res
                    }
                    default: {
                      if (inclusionConfig === undefined) {
                        return FilterResult.UNKNOWN_ENTRY
                      }
                      let xmlStr = stringifyXml([entry])
                      if (inclusionConfig.sysconfig_inclusions?.includes(xmlStr)) {
                        return FilterResult.INCLUDE
                      }
                      if (inclusionConfig.sysconfig_exclusions?.includes(xmlStr)) {
                        return FilterResult.EXCLUDE
                      }
                      return FilterResult.UNKNOWN_ENTRY
                    }
                  }
                },
                exclusions,
                inclusions,
                unknownEntriesMessagePrefix: 'included unknown sysconfigs from ' + xmlFilePath + ':',
                yamlPath: [''],
              },
            } as ProcessXmlCmd

            return await processXml(cmd)
          })
          return {
            dirPath: dstDirPath,
            filePaths: (await Promise.all(fileJobs)).flat(),
          } as SysconfigDir
        },
      )
      return await Promise.all(sysconfigSubDirJobs)
    })
    return {
      partition: partition,
      sysconfigDirs: (await Promise.all(dirJobs)).filter(e => e !== null).flat(),
    } as PartitionSysconfig
  })
  let partSysconfigs = await Promise.all(partJobs)
  let soongModules: SoongModule[] = []
  let moduleNames: string[] = []
  for (let partSysconfig of partSysconfigs) {
    for (let sysconfigDir of partSysconfig.sysconfigDirs) {
      if (sysconfigDir.filePaths.length > 0) {
        let partition = partSysconfig.partition
        let relDirPath = path.relative(path.join(rootOutDir, partition), sysconfigDir.dirPath)
        let moduleName = `adevtool_sysconfig_${partition}_${relDirPath.replace('/', '_')}`

        let soongModule = {
          _type: 'prebuilt_etc',
          name: moduleName,
          srcs: [path.relative(rootOutDir, sysconfigDir.dirPath) + '/*.xml'],
          owner: deviceConfig.device.vendor,
          sub_dir: relDirPath,
        } as SoongModule
        appendPartitionProps(soongModule, partition)
        soongModules.push(soongModule)
        moduleNames.push(moduleName)
      }
    }
  }
  if (soongModules.length > 0) {
    let file = serializeBlueprint({ namespace: true, modules: soongModules })
    await fs.writeFile(path.join(rootOutDir, 'Android.bp'), file)
  }
  return moduleNames
}

export async function loadSysconfigs(pathResolver: PathResolver) {
  let result: string[] = []
  let files = await getSysconfigXmlFiles(pathResolver)
  await Promise.all(
    files.map(async xmlFile => {
      let file = await fs.readFile(xmlFile.path)
      getRootChildren(file, ['config', 'permissions', 'exceptions']).rootChildren.forEach(entry =>
        result.push(stringifyXml([entry])),
      )
    }),
  )
  result.sort()
  return result
}
