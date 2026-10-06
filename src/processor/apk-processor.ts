import assert from 'assert'
import { promises as fs } from 'fs'
import path from 'path'
import { VendorDirectories } from '../blobs/build'
import { PartPath } from '../blobs/file-list'
import { serializeBlueprint, SoongModule } from '../build/soong'
import { DeviceConfig } from '../config/device'
import { SystemState } from '../config/system-state'
import {
  ApkParserConfig,
  ApkParsingConfig,
  ApkParsingConfig_Flag,
} from '../proto-ts/frameworks/base/proto/src/apk_parser_config'
import { BriefPackageInfo } from '../proto-ts/frameworks/base/tools/aapt2/BriefPackageInfo'
import { mapGet, mapSet, objSet } from '../util/data'
import { isDirectory } from '../util/fs'
import { log } from '../util/log'
import { Partition, PathResolver } from '../util/partitions'
import { getCertDigests } from './sepolicy'

export interface BriefApkInfo {
  briefPackageInfo: BriefPackageInfo
  apkPath: string
}

export interface ApkProcessorResult {
  parserConfigModuleName: string
  packageNameMapping: Map<string, string>
  presentBasePackages: Set<string>
  allPackageNames: Set<string>
}

export const APK_PARSER_CONFIG_DIR_NAME = 'apk-parser-config'

export async function processApks(
  config: DeviceConfig,
  infos: BriefApkInfo[],
  sdkVersion: string,
  pathResolver: PathResolver,
  customState: SystemState,
  dirs: VendorDirectories,
) {
  let pkgToCertDigest = new Map<string, string>()

  let installablePkgsConfig = new Set<string>(config.installable_packages)

  let packageInclusions = config.package_inclusions
  let packageExclusions = new Set(config.package_exclusions)

  let allPackageNames = new Set<string>()

  let apc = {
    permissions: {},
    permissionGroups: {},
    contentProviderAuthorities: {},
    nonInstallablePackages: [],
    parsingConfigs: {},
    installablePackages: {},
  } as ApkParserConfig

  let installablePkgs = infos.filter(info => installablePkgsConfig.has(info.briefPackageInfo.packageName))
  let certDigestsMap = await getCertDigests(
    installablePkgs.map(pkg => pkg.apkPath),
    sdkVersion,
  )

  let sdkVersionNum = parseInt(sdkVersion)

  for (let bpiExt of infos) {
    let bpi = bpiExt.briefPackageInfo
    let pkgName = bpi.packageName
    assert(!allPackageNames.has(pkgName))
    allPackageNames.add(pkgName)

    let inclusionConfig = packageInclusions[pkgName]
    if (inclusionConfig === undefined) {
      if (installablePkgsConfig.has(pkgName)) {
        let certDigest = mapGet(certDigestsMap, bpiExt.apkPath)
        objSet(apc.installablePackages, pkgName, certDigest)
      } else {
        apc.nonInstallablePackages.push(pkgName)
        if (!packageExclusions.has(pkgName)) {
          log(
            'included unknown package: ' +
              pkgName +
              ' ' +
              (pathResolver.backResolve(bpiExt.apkPath)?.asPseudoPath() ?? bpiExt.apkPath),
          )
        }
      }
    } else {
      let maxVersionStr = inclusionConfig.max_known_version
      if (maxVersionStr !== undefined) {
        let maxVersion = maxVersionStr === 'auto' ? sdkVersionNum : parseInt(maxVersionStr)
        if (maxVersion !== undefined && bpi.versionCode > maxVersion) {
          log(`${bpi.packageName} version (${bpi.versionCode}) is greater than the max_known_version (${maxVersion})`)
        }
        let knownUsesPerms = new Set(
          (inclusionConfig.include_uses_permissions ?? []).concat(
            inclusionConfig.pregrantable_permissions ?? [],
            inclusionConfig.remove_permissions ?? [],
          ),
        )
        let unknownPerms = bpi.usesPermission.filter(p => !knownUsesPerms.has(p))
        if (unknownPerms.length > 0) {
          unknownPerms.sort()
          log(`${pkgName} has unknown uses-permissions:`)
          for (let p of unknownPerms) {
            log('      - ' + p)
          }
        }
      }

      let flagsInt = 0
      let flags = inclusionConfig.flags
      if (flags !== undefined) {
        for (let flag of flags) {
          // @ts-expect-error: flag is required to be part of ApkParsingConfig.Flag enum
          let intVal = ApkParsingConfig_Flag[flag]
          assert(intVal !== undefined)
          flagsInt |= 1 << (intVal as number)
        }
        assert(flagsInt !== 0)
      }
      let skipUsesPermissions = inclusionConfig.remove_permissions
      if (flagsInt !== 0 || skipUsesPermissions !== undefined) {
        let parsingConfig = {
          skipUsesPermission: skipUsesPermissions ?? [],
          flags: flagsInt,
        } as ApkParsingConfig
        objSet(apc.parsingConfigs, bpi.packageName, parsingConfig)
      }
      apc.nonInstallablePackages.push(pkgName)
    }

    assert(!pkgToCertDigest.has(pkgName))

    pkgToCertDigest.set(pkgName, '')

    for (let auth of new Set(bpi.contentProviderAuthority)) {
      objSet(apc.contentProviderAuthorities, auth, pkgName)
    }

    // some apps have duplicate permission declarations
    let perms = new Set(bpi.permission)

    switch (pkgName) {
      case 'com.google.android.gsf': {
        for (let perm of getGsfGmsCoreSharedPerms()) {
          assert(perms.has(perm), perm)
          perms.delete(perm)
        }
        break
      }
      case 'com.google.android.gms': {
        for (let perm of getGsfGmsCoreSharedPerms()) {
          assert(perms.has(perm), perm)
        }
        break
      }
    }
    for (let perm of perms) {
      objSet(apc.permissions, perm, pkgName)
    }
    for (let permGroup of bpi.permissionGroup) {
      objSet(apc.permissionGroups, permGroup, pkgName)
    }
  }

  let dstDir = path.join(dirs.out, APK_PARSER_CONFIG_DIR_NAME)
  await fs.mkdir(dstDir)
  let fileName = 'apk-parser-config.pb'
  let dstFile = path.join(dstDir, fileName)
  let moduleName = 'adevtool_apk_parser_config'

  let soongModule = {
    _type: 'prebuilt_etc',
    name: moduleName,
    srcs: [fileName],
    owner: config.device.vendor,
    product_specific: true,
  } as SoongModule

  await Promise.all([
    fs.writeFile(dstFile, ApkParserConfig.encode(apc).finish()),
    fs.writeFile(path.join(dstDir, 'Android.bp'), serializeBlueprint({ namespace: true, modules: [soongModule] })),
  ])

  let apkToInfoMap = new Map<string, BriefPackageInfo>()

  for (let apkInfo of infos) {
    mapSet(apkToInfoMap, apkInfo.apkPath, apkInfo.briefPackageInfo)
  }

  let uniqueApks = new Set(config.unique_base_apks)
  let uniqueApexes = new Set(config.unique_base_apexes)

  let packageNameMapping = new Map<string, string>()
  let presentBasePackages = new Set<string>()

  for (let [part, filePaths] of Object.entries(customState.partitionFiles)) {
    for (let relPath of filePaths) {
      if (relPath.endsWith('.apk') && !relPath.startsWith('overlay/') && relPath !== 'framework/framework-res.apk') {
        let pseudoPath = path.join(part, relPath)
        if (uniqueApks.has(pseudoPath)) {
          continue
        }
        let apkMapping = config.apk_map[pseudoPath]
        if (apkMapping === undefined) {
          let pkgInfo = apkToInfoMap.get(pathResolver.resolve(part as Partition, relPath))
          if (pkgInfo === undefined) {
            log('unknown base APK: ' + pseudoPath)
          } else {
            presentBasePackages.add(pkgInfo.packageName)
          }
          continue
        }
        let stockApkPath = PartPath.fromPseudoPath(apkMapping.stock_os_path).resolve(pathResolver)
        let stockInfo = apkToInfoMap.get(stockApkPath)
        if (stockInfo === undefined) {
          let altStockOsPaths = apkMapping.alt_stock_os_paths
          if (altStockOsPaths !== undefined) {
            for (let stockPath of altStockOsPaths) {
              stockInfo = apkToInfoMap.get(PartPath.fromPseudoPath(stockPath).resolve(pathResolver))
              if (stockInfo !== undefined) {
                break
              }
            }
          }
        }
        if (stockInfo === undefined) {
          log('no stock equivalent for base APK ' + pseudoPath)
          continue
        }

        if (stockInfo.packageName !== apkMapping.aosp_apk_name) {
          packageNameMapping.set(stockInfo.packageName, apkMapping.aosp_apk_name)
        }
        presentBasePackages.add(apkMapping.aosp_apk_name)
      }

      let unpackedApexesPrefix = pathResolver.getUnpackedApexDir() + '/'
      let apkInApex = infos.filter(info => info.apkPath.startsWith(unpackedApexesPrefix))

      if (relPath.endsWith('.apex') || relPath.endsWith('.capex')) {
        let pseudoPath = path.join(part, relPath)
        if (uniqueApexes.has(pseudoPath)) {
          continue
        }
        let foundStockApex = false
        let apexMapping = config.apex_map[pseudoPath]
        let unpackedStockApex: string
        if (apexMapping !== undefined) {
          let stockPath = PartPath.fromPseudoPath(apexMapping.stock_os_path)
          unpackedStockApex = pathResolver.resolveUnpackedApexPath(stockPath.partition, stockPath.relPath)
          foundStockApex = await isDirectory(unpackedStockApex)
          if (!foundStockApex) {
            log('invalid APEX mapping for ' + pseudoPath)
          }
        } else {
          unpackedStockApex = pathResolver.resolveUnpackedApexPath(part as Partition, relPath)
          foundStockApex = await isApexOrCapexDir(unpackedStockApex)
          if (!foundStockApex) {
            let name = path.basename(relPath)
            let prefix = 'com.android.'
            if (name.startsWith(prefix)) {
              let googleName = 'com.google.android.' + name.substring(prefix.length)
              unpackedStockApex = pathResolver.resolveUnpackedApexPath(
                part as Partition,
                relPath.slice(0, -name.length) + googleName,
              )
              foundStockApex = await isApexOrCapexDir(unpackedStockApex)
            }
          }
        }
        if (!foundStockApex) {
          log('unknown APEX ' + pseudoPath)
          continue
        }
        let prefix = unpackedStockApex + '/'
        apkInApex
          .filter(info => info.apkPath.startsWith(prefix))
          .forEach(info => {
            let pkgName = info.briefPackageInfo.packageName
            let googlePrefix = 'com.google.android.'
            if (pkgName.startsWith(googlePrefix)) {
              let aospPkgName = 'com.android.' + pkgName.substring(googlePrefix.length)
              packageNameMapping.set(pkgName, aospPkgName)
              presentBasePackages.add(aospPkgName)
            } else {
              presentBasePackages.add(pkgName)
            }
          })
      }
    }
  }

  return {
    parserConfigModuleName: moduleName,
    packageNameMapping,
    presentBasePackages,
    allPackageNames,
  } as ApkProcessorResult
}

function getGsfGmsCoreSharedPerms() {
  return [
    'com.google.android.c2dm.permission.RECEIVE',
    'com.google.android.c2dm.permission.SEND',
    'com.google.android.providers.gsf.permission.READ_GSERVICES',
    'com.google.android.providers.gsf.permission.WRITE_GSERVICES',
    'com.google.android.providers.settings.permission.WRITE_GSETTINGS',
    'com.google.android.gtalkservice.permission.GTALK_SERVICE',
    'com.android.vending.INTENT_VENDING_ONLY',
  ]
}

async function isApexOrCapexDir(path: string) {
  if (await isDirectory(path)) {
    return true
  }
  let suffix = '.apex'
  assert(path.endsWith(suffix))
  return await isDirectory(path.slice(0, -suffix.length) + '.capex')
}
