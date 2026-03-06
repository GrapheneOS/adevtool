import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import { CopyOptions, promises as fs } from 'fs'
import path from 'path'

import assert from 'assert'
import {
  createVendorDirs,
  PROPRIETARY_DIR_IN_ROOT_SOONG_NAMESPACE,
  VendorDirectories,
  writeVersionCheckFile,
} from '../blobs/build'
import {
  decodeCarrierConfigs,
  downloadAllConfigs,
  fetchUpdateConfig,
  getCarrierSettingsUpdatesDir,
  getVersionsMap,
} from '../blobs/carrier'
import { copyBlobs } from '../blobs/copy'
import { BlobEntry } from '../blobs/entry'
import { PseudoPath } from '../blobs/file-list'
import { processOverlays } from '../blobs/overlays2'
import { BuildSystemPackages } from '../build/make'
import {
  DEVICE_CONFIGS_FLAG_WITH_BUILD_ID,
  DeviceBuildId,
  DeviceConfig,
  getDeviceBuildId,
  loadDeviceConfigs2,
} from '../config/device'
import {
  CARRIER_SETTINGS_DIR,
  CARRIER_SETTINGS_FACTORY_PATH,
  COLLECTED_SYSTEM_STATE_DIR,
  OS_CHECKOUT_DIR,
  VENDOR_MODULE_SKELS_DIR,
  VENDOR_MODULE_SPECS_DIR,
} from '../config/paths'
import { forEachDevice } from '../frontend/devices'
import {
  enumerateFiles,
  extractFirmware,
  generateBuildFiles,
  getSdkVersion,
  loadCustomState,
  processProps,
  updatePresigned,
  writeEnvsetupCommands,
} from '../frontend/generate'
import { writeReadme } from '../frontend/readme'
import { DeviceImages, prepareDeviceImages } from '../frontend/source'
import { BuildIndex, ImageType, loadBuildIndex } from '../images/build-index'
import { processApks } from '../processor/apk-processor'
import { processSystemServerClassPaths } from '../processor/classpath'
import { processSepolicy } from '../processor/sepolicy'
import { processSysconfig } from '../processor/sysconfig'
import { processVintf } from '../processor/vintf'
import { gitDiff } from '../util/cli'
import { mapGet } from '../util/data'
import {
  DIR_SPEC_PLACEHOLDER,
  FileTreeComparison,
  FileTreeSpec,
  fileTreeSpecToYaml,
  getFileTreeSpec,
  parseFileTreeSpecYaml,
} from '../util/file-tree-spec'
import { exists, listFilesRecursive } from '../util/fs'
import { log } from '../util/log'
import { PathResolver } from '../util/partitions'

interface DeviceInfo {
  sdkVersion: string
}

async function doDevice(
  dirs: VendorDirectories,
  config: DeviceConfig,
  pathResolver: PathResolver,
  customSrc: string,
  verbose: boolean,
) {
  // customSrc can point to a (directory containing) system state JSON
  let customState = await loadCustomState(config, customSrc)

  // Each step will modify this
  let namedEntries = new Map<PseudoPath, BlobEntry>()

  if (verbose) log('Extracting properties')
  let propResults = await processProps(config, customState, pathResolver)

  if (verbose) log('Enumerating files')
  let sdkVersion = getSdkVersion(propResults)
  let enumerateFilesRes = await enumerateFiles(
    config,
    config.filters.file_exclusions,
    config.filters.file_inclusions,
    namedEntries,
    customState.partitionFiles,
    pathResolver,
    sdkVersion,
  )
  assert(enumerateFilesRes !== null)

  let apkProcessorResult = processApks(config, enumerateFilesRes.apkInfos, sdkVersion, pathResolver, customState, dirs)

  // After this point, we only need entry objects
  let entries = Array.from(namedEntries.values())

  let sysconfigModules = processSysconfig(config, pathResolver, apkProcessorResult, customState, dirs)

  if (verbose) log('Processing sepolicy')
  let sepolicyDirs = processSepolicy(config, customState, pathResolver, apkProcessorResult, dirs)

  if (verbose) log('Processing overlays')
  let overlayPkgs = processOverlays(config, dirs, pathResolver.basePath)

  if (verbose) log('Marking apps as presigned')
  let updatePresignedPromise = updatePresigned(entries, pathResolver, sdkVersion)

  // modifies entries array, needs await
  let productSystemServerJars: string[] = await processSystemServerClassPaths(entries, pathResolver, customState)

  if (verbose) log('Copying blobs')
  let copyBlobsPromise = copyBlobs(
    entries,
    pathResolver,
    dirs.proprietary,
    path.join(dirs.out, PROPRIETARY_DIR_IN_ROOT_SOONG_NAMESPACE),
    config.device.name,
  )

  if (verbose) log('Extracting vintf manifests')
  let vintfPaths = processVintf(config, pathResolver, customState, dirs)

  if (verbose) log('Extracting firmware')
  let fwPaths = extractFirmware(config, dirs, propResults.stockProps, pathResolver)

  let buildPkgs: BuildSystemPackages[] = [
    { type: 'AOSP overrides for missing proprietary files', names: customState.extraModules },
    { type: 'sysconfig', names: await sysconfigModules },
    { type: 'APK parser config', names: [(await apkProcessorResult).parserConfigModuleName] },
    { type: 'generated overlays', names: await overlayPkgs },
  ]

  await copyBlobsPromise
  await updatePresignedPromise

  await generateBuildFiles(
    config,
    dirs,
    entries,
    buildPkgs,
    propResults,
    productSystemServerJars,
    await fwPaths,
    await vintfPaths,
    await sepolicyDirs,
    pathResolver,
    customState,
  )

  await Promise.all([writeEnvsetupCommands(config, dirs), writeReadme(config, dirs, await propResults)])

  return { sdkVersion } as DeviceInfo
}

export default class GenerateFull extends Command {
  static description = 'generate all vendor parts automatically'

  static flags = {
    help: Flags.help({ char: 'h' }),
    customSrc: Flags.string({
      char: 'c',
      description: 'path to AOSP build output directory (out/) or (directory containing) JSON state file',
      default: COLLECTED_SYSTEM_STATE_DIR,
    }),
    parallel: Flags.boolean({
      char: 'p',
      description: 'generate devices in parallel',
      default: true,
      allowNo: true,
    }),
    verbose: Flags.boolean({ char: 'v' }),
    updateSpec: Flags.boolean({
      description:
        'update vendor module FileTreeSpec in vendor-specs/ instead of requiring it to be equal to the reference (current) spec',
    }),
    noVerify: Flags.boolean({
      description: 'skip comparison against the reference FileTreeSpec',
    }),
    doNotReplaceCarrierSettings: Flags.boolean({
      description: `do not replace carrier settings with updated ones from ${CARRIER_SETTINGS_DIR}`,
    }),

    doNotDownloadCarrierSettings: Flags.boolean({}),

    ...DEVICE_CONFIGS_FLAG_WITH_BUILD_ID,
  }

  async run() {
    let { flags } = await this.parse(GenerateFull)

    let devices = await loadDeviceConfigs2(flags)
    let index: BuildIndex = await loadBuildIndex()

    await forEachDevice(
      devices,
      flags.parallel,
      async config => {
        let images: Map<DeviceBuildId, DeviceImages> = await prepareDeviceImages(index, [ImageType.Factory], [config])
        let deviceImages = mapGet(images, getDeviceBuildId(config))
        let pathResolver = new PathResolver(deviceImages.unpackedFactoryImageDir)
        let backportBuildId = config.device.backport_build_id
        if (backportBuildId !== undefined) {
          let backportDeviceImages = mapGet(images, getDeviceBuildId(config, backportBuildId))
          let fileOverlays: { [part: string]: Set<string> } = Object.fromEntries(Object.entries(config.backport_files).map(([k, v]) => [k, new Set(v)]))
          let fileOverlaysByDir: { [part: string]: { [dir: string]: Set<string> } } = {}
          for (let [part, filePaths] of Object.entries(fileOverlays)) {
            let filesByDir: { [dir: string]: Set<string> } = {}
            for (let filePath of filePaths) {
              let dirName = path.dirname(filePath)
              let fileNames = filesByDir[dirName]
              if (fileNames === undefined) {
                fileNames = new Set<string>()
                filesByDir[dirName] = fileNames
              }
              let fileName = path.basename(filePath)
              if (fileNames.has(fileName)) {
                throw new Error('duplicate backport file: ' + fileName)
              }
              fileNames.add(fileName)
            }
            fileOverlaysByDir[part] = filesByDir
          }

          pathResolver.overlay = {
            basePath: backportDeviceImages.unpackedFactoryImageDir,
            dirOverlays: config.backport_dirs,
            fileOverlays,
            fileOverlaysByDir,
          }
        }
        // Prepare output directories
        let vendorDirs = await createVendorDirs(config.device.vendor, config.device.name)

        let deviceInfo = await doDevice(vendorDirs, config, pathResolver, flags.customSrc, flags.verbose)

        if (!flags.doNotReplaceCarrierSettings) {
          if (flags.updateSpec && config.device.has_cellular && !flags.doNotDownloadCarrierSettings) {
            log(chalk.bold(`Downloading carrier settings updates`))
            const csUpdateConfig = await fetchUpdateConfig(
              config.device.name,
              config.device.build_id,
              deviceInfo.sdkVersion,
              false,
            )
            await downloadAllConfigs(csUpdateConfig, getCarrierSettingsUpdatesDir(config), false)
          }

          const srcCsDir = getCarrierSettingsUpdatesDir(config)
          const dstCsDir = getCarrierSettingsVendorDir(vendorDirs)
          if (await exists(srcCsDir)) {
            if (flags.verbose) {
              log(`Updating carrier settings from ${path.relative(OS_CHECKOUT_DIR, srcCsDir)}`)
            }
            const srcVersions = await getVersionsMap(srcCsDir)
            const dstVersions = await getVersionsMap(dstCsDir)
            for await (let file of listFilesRecursive(srcCsDir)) {
              if (path.extname(file) !== '.pb') {
                continue
              }
              const carrierName = path.parse(file).name
              const srcVer = srcVersions.get(carrierName) ?? 0
              const dstVer = dstVersions.get(carrierName) ?? 0
              if (srcVer < dstVer) {
                if (flags.verbose) log(`skipping copying ${file} due to older version (${srcVer}<${dstVer})`)
                continue
              }
              const destFile = path.join(dstCsDir, path.basename(file))
              await fs.rm(destFile, { force: true })
              await fs.copyFile(file, destFile)
            }
          }
        }

        if (flags.updateSpec) {
          let skelDir = getVendorModuleSkelDir(config)
          await fs.rm(skelDir, { force: true, recursive: true })
          await Promise.all([
            copyVendorSkel(skelDir, vendorDirs),
            writeVendorFileTreeSpec(vendorDirs, config, flags.verbose),
          ])
          let decodedCarrierSettingsDir = path.join(skelDir, 'proprietary', CARRIER_SETTINGS_FACTORY_PATH)
          await decodeCarrierConfigs(getCarrierSettingsVendorDir(vendorDirs), decodedCarrierSettingsDir)
        } else {
          if (!flags.noVerify) {
            try {
              if (flags.verbose) {
                log('Verifying FileTreeSpec')
              }
              await compareToReferenceFileTreeSpec(vendorDirs, config)
            } catch (e) {
              await fs.rm(vendorDirs.out, { recursive: true })
              throw e
            }
          }
        }
        await writeVersionCheckFile(config, vendorDirs, flags.noVerify)
        log('Generated vendor module at ' + vendorDirs.out)
      },
      config => config.device.name,
    )
  }
}

async function compareToReferenceFileTreeSpec(vendorDirs: VendorDirectories, config: DeviceConfig) {
  let specFile = getVendorModuleTreeSpecFile(config)
  if (!(await exists(specFile))) {
    throw new Error(
      `Missing vendor module tree spec, use --${GenerateFull.flags.updateSpec.name} flag to generate it. Path: ` +
        specFile,
    )
  }
  let fileTreeSpec = getFileTreeSpec(vendorDirs.out)

  let referenceFileTreeSpec: FileTreeSpec = parseFileTreeSpecYaml((await fs.readFile(specFile)).toString())

  let cmp = await FileTreeComparison.get(referenceFileTreeSpec, await fileTreeSpec)

  let gitDiffs: Promise<string>[] = []

  let vendorSkelDir = getVendorModuleSkelDir(config)

  for (let changedEntry of cmp.changedEntries) {
    if (cmp.a.get(changedEntry) === DIR_SPEC_PLACEHOLDER || cmp.b.get(changedEntry) === DIR_SPEC_PLACEHOLDER) {
      // directory became a regular file or vice versa
      continue
    }

    let skelFile = path.join(vendorSkelDir, changedEntry)
    if (await exists(skelFile)) {
      gitDiffs.push(gitDiff(skelFile, path.resolve(vendorDirs.out, changedEntry)))
    }
  }

  for await (let diff of gitDiffs) {
    log(diff)
  }

  if (cmp.changedEntries.length > 0) {
    log(chalk.bold('\nChanged entries:'))
    for (let e of cmp.changedEntries) {
      log(e + ': ' + cmp.a.get(e) + ' -> ' + cmp.b.get(e))
    }
  }

  if (cmp.newEntries.size > 0) {
    log(chalk.bold(`\nNew entries:`))
    for (let [k, v] of cmp.newEntries) {
      log(k + ': ' + v)
    }
  }

  if (cmp.missingEntries.size > 0) {
    log(chalk.bold('\nMissing entries:'))
    for (let [k, v] of cmp.missingEntries) {
      log(k + ': ' + v)
    }
  }

  if (cmp.numDiffs() != 0) {
    log('\n')
    throw new Error(`Vendor module for ${
      config.device.name
    } doesn't match its FileTreeSpec in ${getVendorModuleTreeSpecFile(config)}.
To update it, use the --${GenerateFull.flags.updateSpec.name} flag.`)
  }
}

async function writeVendorFileTreeSpec(dirs: VendorDirectories, config: DeviceConfig, verbose: boolean) {
  let fileTreeSpec = getFileTreeSpec(dirs.out)

  let dstFile = getVendorModuleTreeSpecFile(config)
  await fs.mkdir(path.parse(dstFile).dir, { recursive: true })
  await fs.writeFile(dstFile, fileTreeSpecToYaml(await fileTreeSpec))
  if (verbose) log('Updated FileTreeSpec at ' + dstFile)
}

// see readme in vendor-skels/ dir
async function copyVendorSkel(skelDir: string, dirs: VendorDirectories) {
  let copyOptions = {
    errorOnExist: true,
    force: false,
    preserveTimestamps: false,
    recursive: true,
    async filter(source: string): Promise<boolean> {
      if (source.endsWith('.img')) {
        return false
      }

      if (source.startsWith(dirs.proprietary)) {
        if ((await fs.stat(source)).isDirectory()) {
          return true
        }

        if (source.endsWith('gnss/gps.xml') || source.endsWith('gnss/gps.cfg')) {
          return true
        }

        if (
          source.endsWith('android.hardware.usb-service.rc') ||
          source.endsWith('android.hardware.usb-service-i2c6.rc')
        ) {
          return true
        }

        if (source.includes('/', dirs.proprietary.length + 1)) {
          // skip proprietary/*/* entries
          return false
        }

        if (source.length > dirs.proprietary.length) {
          if (path.extname(source) === '') {
            // skip now-empty proprietary/* dirs
            return false
          }
        }
      }
      return true
    },
  } as CopyOptions

  await fs.cp(dirs.out, skelDir, copyOptions)
}

function getVendorModuleTreeSpecFile(config: DeviceConfig) {
  return path.join(VENDOR_MODULE_SPECS_DIR, config.device.vendor, `${config.device.name}.yml`)
}

function getVendorModuleSkelDir(config: DeviceConfig) {
  return path.join(VENDOR_MODULE_SKELS_DIR, config.device.vendor, config.device.name)
}

function getCarrierSettingsVendorDir(dirs: VendorDirectories) {
  return path.join(dirs.proprietary, CARRIER_SETTINGS_FACTORY_PATH)
}
