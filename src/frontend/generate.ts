import { promises as fs } from 'fs'
import path from 'path'

import { PROPRIETARY_DIR_IN_ROOT_SOONG_NAMESPACE, VendorDirectories } from '../blobs/build'
import { ApkSigningMode, BlobEntry, blobNeedsSoong } from '../blobs/entry'
import { listPart, PartPath, PseudoPath } from '../blobs/file-list'
import { loadPartitionProps, PartitionProps } from '../blobs/props'
import {
  blobToFileCopy,
  BuildSystemPackages,
  genBoardMakefile,
  genModulesMakefile,
  genProductMakefile,
  sanitizeBasename,
  Symlink,
} from '../build/make'
import {
  blobToSoongModule,
  serializeBlueprint,
  SharedLibraryModule,
  SoongModule,
  SPECIAL_FILE_EXTENSIONS,
  TYPE_SHARED_LIBRARY,
} from '../build/soong'
import { DeviceConfig, getExcludedPackages } from '../config/device'
import { Filters, filterValue } from '../config/filters'
import { getHostBinPath } from '../config/paths'
import { parseSystemState, SystemState } from '../config/system-state'
import { extractFactoryFirmware, writeFirmwareImages } from '../images/firmware'
import { BriefApkInfo } from '../processor/apk-processor'
import { getCertDigests, SepolicyDirs } from '../processor/sepolicy'
import { SYSCONFIG_DIR_NAMES } from '../processor/sysconfig'
import { VintfPaths } from '../processor/vintf'
import { getBriefPackageInfo } from '../util/aapt2'
import { assertDefined, filterAsync, mapGet } from '../util/data'
import { EntryFilter2Cmd, filterEntries2, FilterResult } from '../util/exact-filter'
import { isFile, listFilesRecursive, readFile } from '../util/fs'
import { log } from '../util/log'
import { ALL_SYS_PARTITIONS, Partition, PathResolver } from '../util/partitions'
import { UNPACKED_APEXES_DIR_NAME } from './source'

export interface PropResults {
  stockProps: PartitionProps
  missingProps?: PartitionProps

  missingOtaParts: Array<string>
}

export async function loadCustomState(config: DeviceConfig, customSrc: string) {
  let path: string
  let deviceSrc = `${customSrc}/${config.device.name}.json`
  if (await isFile(deviceSrc)) {
    path = deviceSrc
  } else {
    if (!(await isFile(customSrc))) {
      throw new Error('missing file: ' + customSrc)
    }
    path = customSrc
  }
  return parseSystemState(await readFile(path))
}

export interface EnumerateFilesResult {
  apkInfos: BriefApkInfo[]
}

export async function enumerateFilesForCollectState(
  baseFileList: { [part: string]: string[] },
  pathResolver: PathResolver,
) {
  let namedEntries = new Map<PseudoPath, BlobEntry>()

  for (let partition of ALL_SYS_PARTITIONS) {
    let allPartFiles = await listPart(partition, pathResolver)
    if (allPartFiles === null) {
      continue
    }

    let baseRelPaths = new Set(baseFileList[partition] ?? [])

    for (let partPath of allPartFiles) {
      if (baseRelPaths.has(partPath.relPath)) {
        continue
      }
      let pseudoPath = partPath.asPseudoPath()
      let entry = {
        partPath,
      } as BlobEntry
      namedEntries.set(pseudoPath, entry)
    }
  }
  return namedEntries
}

export async function enumerateFiles(
  config: DeviceConfig,
  filters: Filters,
  inclusionFilters: Filters | null,
  namedEntries: Map<PseudoPath, BlobEntry>,
  excludedFiles: { [part: string]: string[] } | null,
  pathResolver: PathResolver,
  sdkVersion: string,
) {
  let unknownPaths: PartPath[] = []
  let excludedPackages = getExcludedPackages(config)
  let apkPaths: string[] = []

  let aapt2 = await getHostBinPath('aapt2')

  let allPartFilesMap = new Map<Partition, PartPath[]>()

  for (let partition of ALL_SYS_PARTITIONS) {
    let allPartFiles = await listPart(partition, pathResolver)
    if (allPartFiles === null) {
      continue
    }
    allPartFilesMap.set(partition, allPartFiles)
    for (let filePath of allPartFiles) {
      if (
        filePath.relPath.endsWith('.apk') &&
        !filePath.relPath.startsWith('overlay/') &&
        !(filePath.relPath === 'framework/framework-res.apk' && filePath.partition === Partition.System)
      ) {
        apkPaths.push(filePath.resolve(pathResolver))
      }
    }
  }

  let res: EnumerateFilesResult | null = null

  for await (let filePath of listFilesRecursive(path.join(pathResolver.basePath, UNPACKED_APEXES_DIR_NAME))) {
    if (filePath.endsWith('.apk')) {
      apkPaths.push(filePath)
    }
  }

  let packageInfos = new Map(
    await Promise.all(
      apkPaths.map(async apkPath => {
        return [
          apkPath,
          {
            briefPackageInfo: await getBriefPackageInfo(aapt2, sdkVersion, apkPath),
            apkPath,
          } as BriefApkInfo,
        ] as [string, BriefApkInfo]
      }),
    ),
  )

  res = { apkInfos: Array.from(packageInfos.values()) } as EnumerateFilesResult

  let etcExclusions = new Set(['selinux', 'vintf', ...SYSCONFIG_DIR_NAMES])

  for (let [partition, allPartFiles] of allPartFilesMap.entries()) {
    let excludedPartFiles = new Set<string>(excludedFiles !== null ? (excludedFiles[partition] ?? []) : [])

    if (pathResolver.overlay !== undefined) {
      let fileOverlays = pathResolver.overlay.fileOverlays[partition]
      if (fileOverlays !== undefined) {
        for (let relPath of fileOverlays) {
          excludedPartFiles.delete(relPath)
        }
      }
    }

    if (partition === Partition.Recovery) {
      // prebuilt librecovery_ui_ext includes additional proprietary code
      excludedPartFiles.delete('system/lib64/librecovery_ui_ext.so')
    }

    let filteredPartPaths = await filterAsync(allPartFiles, async partPath => {
      // filter out files that have special handling
      let relPath = partPath.relPath
      if (relPath.startsWith('etc/')) {
        let components = relPath.split('/', 3)
        if (etcExclusions.has(components[1])) {
          return false
        }
      } else if (relPath.startsWith('overlay/')) {
        return false
      }

      if (excludedPartFiles.has(relPath)) {
        return false
      }

      if (excludedPackages.size > 0 && relPath.endsWith('.apk')) {
        let pkgName = (await getBriefPackageInfo(aapt2, sdkVersion, partPath.resolve(pathResolver))).packageName
        if (excludedPackages.has(pkgName)) {
          return false
        }
      }

      return filterValue(filters, partPath.asPseudoPath())
    })

    for (let partPath of filteredPartPaths) {
      let pseudoPath = partPath.asPseudoPath()
      if (inclusionFilters !== null && !filterValue(inclusionFilters, pseudoPath)) {
        if (!pseudoPath.endsWith('.apk')) {
          // unknown APKs are handled by APK processor
          unknownPaths.push(partPath)
        }
      }
      let entry = {
        partPath,
      } as BlobEntry
      if (pseudoPath.endsWith('.apk')) {
        entry.apkInfo = mapGet(packageInfos, partPath.resolve(pathResolver)).briefPackageInfo
      }
      namedEntries.set(pseudoPath, entry)
    }
  }
  if (unknownPaths.length > 0) {
    unknownPaths.sort()

    let entries = await Promise.all(
      unknownPaths.map(async p => {
        if (!p.relPath.endsWith('.apk')) {
          return p.asPseudoPath()
        }
        let packageName = (await getBriefPackageInfo(aapt2, sdkVersion, p.resolve(pathResolver))).packageName
        return p.asPseudoPath() + ' | ' + packageName
      }),
    )
    log(`included unknown files:`)
    for (let e of entries) {
      log('      - ' + e)
    }
  }

  return res
}

export async function updatePresigned(entries: BlobEntry[], pathResolver: PathResolver, sdkVersion: string) {
  let platformSignedApk = pathResolver.resolve(Partition.System, 'framework/framework-res.apk')
  let releasekeyCertSignedApk = pathResolver.resolve(Partition.System, 'app/BookmarkProvider/BookmarkProvider.apk')

  let apks = new Map<string, BlobEntry>()
  entries
    .filter(e => path.extname(e.partPath.relPath) === '.apk')
    .forEach(entry => {
      let apkPath = entry.partPath.resolve(pathResolver)
      apks.set(apkPath, entry)
    })
  let apksToProcess = [platformSignedApk, releasekeyCertSignedApk, ...apks.keys()]
  let digests = await getCertDigests(apksToProcess, sdkVersion)

  let platformCertDigest = mapGet(digests, platformSignedApk)
  let releasekeyDigest = mapGet(digests, releasekeyCertSignedApk)

  for (let [apkPath, entry] of apks.entries()) {
    let certDigest = mapGet(digests, apkPath)
    if (certDigest === platformCertDigest) {
      entry.apkSigningMode = ApkSigningMode.RESIGN_WITH_PLATFORM_CERT
    } else if (certDigest === releasekeyDigest) {
      entry.apkSigningMode = ApkSigningMode.RESIGN_WITH_RELEASEKEY_CERT
    } else {
      entry.apkSigningMode = ApkSigningMode.DO_NOT_RESIGN
    }
  }
}

type SysProp = {
  key: string
  value: string
}

function filterProps(partProps: PartitionProps, exclusions: Set<string>, inclusions: Set<string>) {
  let filteredPartProps: PartitionProps = new Map<string, Map<string, string>>()
  for (let [part, props] of partProps.entries()) {
    let cmd = {
      entries: Array.from(props.entries()).map(([key, value]) => [
        stringifySysProp(key, value),
        { key, value } as SysProp,
      ]),
      process(_: string, sysProp: SysProp) {
        if (exclusions.has(sysProp.key)) {
          return FilterResult.EXCLUDE
        }
        if (inclusions.has(sysProp.key)) {
          return FilterResult.INCLUDE
        }
        return FilterResult.UNKNOWN_ENTRY
      },
      exclusions,
      inclusions,
      unknownEntriesMessagePrefix: `included unknown ${part} sysprops:`,
      yamlPath: [''],
    } as EntryFilter2Cmd<SysProp>
    let filteredProps = new Map<string, string>()
    for (let [, sysProp] of filterEntries2(cmd).entries) {
      filteredProps.set(sysProp.key, sysProp.value)
    }
    filteredPartProps.set(part, filteredProps)
  }
  return filteredPartProps
}

function stringifySysProp(key: string, value: string) {
  if (value === undefined) {
    log(key)
    return key
  }
  if (value.length === 0) {
    return key + ' =' // omit trailing space to ease YAML handling
  }
  return key + ' = ' + value
}

export async function processProps(
  config: DeviceConfig,
  customState: SystemState | null,
  pathResolver: PathResolver,
  isForPrepModule: boolean = false,
) {
  let exclusions = new Set(config.sysprop_exclusions)
  if (customState !== null) {
    Array.from(customState.partitionProps.values()).forEach(map =>
      Array.from(map.entries()).forEach(([k, v]) => {
        exclusions.add(stringifySysProp(k, v))
      }),
    )
  }

  let inclusions = new Set(config.sysprop_inclusions)

  let stockProps = await loadPartitionProps(pathResolver, config, isForPrepModule)

  let missingProps = customState !== null ? filterProps(stockProps, exclusions, inclusions) : undefined

  // A/B OTA partitions
  let stockOtaParts = assertDefined(getAbOtaPartitions(stockProps))
  let customOtaParts =
    customState !== null ? new Set(getAbOtaPartitions(customState.partitionProps) ?? []) : new Set<string>()
  let missingOtaParts = stockOtaParts.filter(p => !customOtaParts.has(p) && filterValue(config.filters.partitions, p))

  return {
    stockProps,
    missingProps,
    missingOtaParts,
  } as PropResults
}

export function getSdkVersion(propResults: PropResults) {
  return mapGet(mapGet(propResults.stockProps, Partition.System), 'ro.build.version.sdk')
}

export function getAbOtaPartitions(props: PartitionProps): string[] | undefined {
  return props.get(Partition.Product)?.get('ro.product.ab_ota_partitions')?.split(',')
}

export async function extractFirmware(
  config: DeviceConfig,
  dirs: VendorDirectories,
  stockProps: PartitionProps,
  pathResolver: PathResolver,
) {
  let fwImages = await extractFactoryFirmware(config, stockProps, pathResolver)
  return await writeFirmwareImages(fwImages, dirs.firmware)
}

function nameDepKey(entry: BlobEntry) {
  let ext = path.extname(entry.partPath.relPath)
  return `${ext == '.xml' ? 1 : 0}${entry.partPath.asPseudoPath()}`
}

export async function generateBuildFiles(
  config: DeviceConfig,
  dirs: VendorDirectories,
  entries: BlobEntry[],
  buildPkgs: BuildSystemPackages[],
  propResults: PropResults,
  productSystemServerJars: string[],
  fwPaths: string[] | null,
  vintfPaths: Map<string, VintfPaths> | null,
  sepolicyDirs: SepolicyDirs | null,
  pathResolver: PathResolver,
  customState: SystemState | null,
) {
  // Re-sort entries to give priority to explicit named dependencies in name
  // conflict resolution. XMLs are also de-prioritized because they have
  // filename_from_src.
  entries = entries.toSorted((a, b) => nameDepKey(a).localeCompare(nameDepKey(b)))

  // Fast lookup for other arch libs
  let entrySrcPaths = new Set(entries.map(e => e.partPath.asPseudoPath()))

  // Create Soong modules, Make rules, and symlink modules
  let copyFiles: string[] = []
  let symlinks: Symlink[] = []
  let allNamedModules = new Map<string, SoongModule>()
  let localNamespaceModules: SoongModule[] = []
  let rootNamespaceModules: SoongModule[] = []

  // Conflict resolution: all candidate modules with the same name, plus counters
  let conflictModules = new Map<string, SoongModule[]>()
  let conflictCounters = new Map<string, number>()

  let dexOnlyLibraries = new Set(
    entries
      .filter(entry => entry.partPath.relPath.endsWith('.jar'))
      .map(entry => path.basename(entry.partPath.relPath, '.jar')),
  )

  let multiPartLibraries = new Set<string>()
  {
    let libs = new Set<string>()
    for (let entry of entries) {
      let relPath = entry.partPath.relPath
      if (!relPath.endsWith('.so')) {
        continue
      }

      if (libs.has(relPath)) {
        let name = path.basename(relPath).slice(0, -'.so'.length)
        multiPartLibraries.add(name)
      } else {
        libs.add(relPath)
      }
    }
  }

  entryLoop: for (let entry of entries) {
    if (entry.partPath.partition === Partition.Recovery) {
      switch (entry.partPath.relPath) {
        // handled by TARGET_RECOVERY_FSTAB
        case 'system/etc/recovery.fstab':
        // handled by TARGET_RECOVERY_WIPE
        case 'system/etc/recovery.wipe':
          continue
      }
    }

    let ext = path.extname(entry.partPath.relPath)
    let pathParts = entry.partPath.relPath.split('/')
    let srcPath = entry.partPath.resolve(pathResolver)
    let stat = await fs.lstat(srcPath)

    if (stat.isSymbolicLink()) {
      // Symlink -> Make module, regardless of file extension

      let targetPath = await fs.readlink(srcPath)
      let moduleName = `symlink__${sanitizeBasename(entry.partPath.relPath)}`

      // Create link info
      symlinks.push({
        moduleName,
        linkPartPath: entry.partPath,
        targetPath,
      } as Symlink)
      continue
    } else if (blobNeedsSoong(entry, ext)) {
      // Named dependencies -> Soong blueprint

      // Module name = file name, excluding extension if it was used
      let baseExt = SPECIAL_FILE_EXTENSIONS.has(ext) ? ext : undefined
      let name = path.basename(entry.partPath.relPath, baseExt)
      if (baseExt === '.so' && entry.partPath.partition !== Partition.Vendor && multiPartLibraries.has(name)) {
        // same-name libraries can be present on more than one partition, suffix module name of non-vendor/ libraries
        // with partition name to avoid duplicate module definitions
        name = `${name}.${entry.partPath.partition}`
      }
      let resolvedName = name

      // If already exists: skip if it's the other arch variant of a library in
      // the same partition AND has the same name (incl. ext), otherwise rename the
      // module to avoid conflict
      if (allNamedModules.has(name)) {
        for (let conflictModule of conflictModules.get(name)!) {
          if (
            conflictModule._type == TYPE_SHARED_LIBRARY &&
            (conflictModule as SharedLibraryModule).compile_multilib == 'both' &&
            conflictModule._entry?.partPath.relPath.split('/').at(-1) == pathParts.at(-1)
          ) {
            // Same partition = skip arch variant
            if (conflictModule._entry?.partPath.partition === entry.partPath.partition) {
              continue entryLoop
            }
          }
        }

        // Increment conflict counter and append to name
        let conflictNum = (conflictCounters.get(name) ?? 1) + 1
        conflictCounters.set(name, conflictNum)
        resolvedName += `__${conflictNum}`
      }

      if (config.device.backport_build_id !== undefined) {
        if (resolvedName === 'libc++' || resolvedName === 'libaconfig_storage_read_api_cc') {
          copyFiles.push(blobToFileCopy(entry, dirs.proprietary))
          continue
        }
      }


      let module = blobToSoongModule(
        config,
        resolvedName,
        ext,
        config.device.vendor,
        entry,
        entrySrcPaths,
        dexOnlyLibraries,
      )
      allNamedModules.set(resolvedName, module)
      if (entry.useRootSoongNamespace === true) {
        rootNamespaceModules.push(module)
      } else {
        localNamespaceModules.push(module)
      }

      // Save all conflicting modules for conflict resolution
      if (conflictModules.get(name)?.push(module) === undefined) {
        conflictModules.set(name, [module])
      }
      continue
    }

    // Other files -> Kati Makefile

    // Simple PRODUCT_COPY_FILES line
    copyFiles.push(blobToFileCopy(entry, dirs.proprietary))
  }

  let packages: BuildSystemPackages[] = []
  packages.push(...buildPkgs)
  packages.push({ type: 'file-based packages', names: Array.from(allNamedModules.keys()).sort() })
  if (config.extra_packages.length > 0) {
    packages.push({ type: 'extra packages', names: config.extra_packages })
  }

  if (symlinks.length > 0) {
    packages.push({ type: 'inclusion of symlinks', names: ['device_symlinks'] })
  }

  let writes: Promise<void>[] = []

  if (localNamespaceModules.length > 0) {
    writes.push(
      fs.writeFile(
        path.join(dirs.proprietary, 'Android.bp'),
        serializeBlueprint({
          namespace: true,
          modules: localNamespaceModules,
        }),
      ),
    )
  }

  if (rootNamespaceModules.length > 0) {
    writes.push(
      fs.writeFile(
        path.join(dirs.out, PROPRIETARY_DIR_IN_ROOT_SOONG_NAMESPACE, 'Android.bp'),
        serializeBlueprint({
          modules: rootNamespaceModules,
        }),
      ),
    )
  }

  writes.push(genModulesMakefile(config, symlinks, fwPaths, dirs))
  writes.push(genBoardMakefile(config, sepolicyDirs, propResults, fwPaths, dirs, pathResolver, customState === null))

  writes.push(
    genProductMakefile(
      config,
      packages,
      copyFiles,
      vintfPaths,
      propResults,
      productSystemServerJars,
      dirs,
      pathResolver,
      customState,
    ),
  )

  await Promise.all(writes)
}

export async function writeEnvsetupCommands(config: DeviceConfig, dirs: VendorDirectories) {
  let vars = new Map<string, string | undefined>()
  let product = config.device.name

  vars.set(`BUILD_ID_${product}`, config.device.build_id)
  vars.set(`PLATFORM_SECURITY_PATCH_${product}`, config.device.platform_security_patch_level_override)

  let cmds: string[] = []

  for (let [k, v] of vars.entries()) {
    if (v === undefined) {
      cmds.push(`unset ${k}`)
    } else {
      cmds.push(`export ${k}="${v}"`)
    }
  }
  cmds.push('')

  await fs.writeFile(path.join(dirs.out, 'cmds-for-envsetup.sh'), cmds.join('\n'))
}
