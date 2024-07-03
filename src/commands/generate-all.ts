import { Command, Flags } from '@oclif/core'
import assert from 'assert'
import chalk from 'chalk'
import { CopyOptions, promises as fs } from 'fs'
import path from 'path'

import { createVendorDirs, VendorDirectories } from '../blobs/build'
import { copyBlobs } from '../blobs/copy'
import { BlobEntry } from '../blobs/entry'
import { DEVICE_CONFIG_FLAGS, DeviceBuildId, DeviceConfig, getDeviceBuildId, loadDeviceConfigs } from '../config/device'
import {
  ADEVTOOL_DIR,
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
  extractOverlays,
  extractProps,
  extractVintfManifests,
  flattenApexs,
  generateBuildFiles,
  loadCustomState,
  PropResults,
  resolveOverrides,
  resolveSepolicyDirs,
  updatePresigned,
  writeEnvsetupCommands,
} from '../frontend/generate'
import { writeReadme } from '../frontend/readme'
import { DeviceImages, prepareDeviceImages, WRAPPED_SOURCE_FLAGS, wrapSystemSrc } from '../frontend/source'
import { BuildIndex, ImageType, loadBuildIndex } from '../images/build-index'
import { SelinuxPartResolutions } from '../selinux/contexts'
import { gitDiff, withSpinner } from '../util/cli'
import {
  DIR_SPEC_PLACEHOLDER,
  FileTreeComparison,
  FileTreeSpec,
  fileTreeSpecToYaml,
  getFileTreeSpec,
  parseFileTreeSpecYaml,
} from '../util/file-tree-spec'
import { exists, listFilesRecursive, withTempDir } from '../util/fs'
import { spawnAsync } from '../util/process'
import {
  decodeConfigs,
  downloadAllConfigs,
  fetchUpdateConfig,
  getCarrierSettingsUpdatesDir,
  getVersionsMap,
} from '../blobs/carrier'

const doDevice = (
  dirs: VendorDirectories,
  config: DeviceConfig,
  stockSrc: string,
  customSrc: string,
  aapt2Path: string,
  buildId: string | undefined,
  factoryPath: string | undefined,
  skipCopy: boolean,
  useTemp: boolean,
) =>
  withTempDir(async tmp => {
    // Prepare stock system source
    let wrapBuildId = buildId == undefined ? null : buildId
    let wrapped = await withSpinner('Extracting stock system source', spinner =>
      wrapSystemSrc(stockSrc, config.device.name, wrapBuildId, useTemp, tmp, spinner),
    )
    stockSrc = wrapped.src!
    if (wrapped.factoryPath != null && factoryPath == undefined) {
      factoryPath = wrapped.factoryPath
    }

    // customSrc can point to a (directory containing) system state JSON or out/
    let customState = await loadCustomState(config, aapt2Path, customSrc)

    // Each step will modify this. Key = combined part path
    let namedEntries = new Map<string, BlobEntry>()

    // 1. Diff files
    await withSpinner('Enumerating files', spinner =>
      enumerateFiles(spinner, config.filters.files, config.filters.dep_files, namedEntries, customState, stockSrc),
    )

    // 2. Overrides
    let buildPkgs: string[] = []
    if (config.generate.overrides) {
      let builtModules = await withSpinner('Replacing blobs with buildable modules', () =>
        resolveOverrides(config, customState, dirs, namedEntries),
      )
      buildPkgs.push(...builtModules)
    }
    // After this point, we only need entry objects
    let entries = Array.from(namedEntries.values())

    // 3. Presigned
    if (config.generate.presigned) {
      await withSpinner('Marking apps as presigned', spinner =>
        updatePresigned(spinner, config, entries, aapt2Path, stockSrc),
      )
    }

    // 4. Flatten APEX modules
    if (config.generate.flat_apex) {
      entries = await withSpinner('Flattening APEX modules', spinner =>
        flattenApexs(spinner, entries, dirs, tmp, stockSrc),
      )
    }

    // 5. Extract
    // Copy blobs (this has its own spinner)
    if (config.generate.files && !skipCopy) {
      await copyBlobs(entries, stockSrc, dirs.proprietary)
    }

    // 6. Props
    let propResults: PropResults | null = null
    if (config.generate.props) {
      propResults = await withSpinner('Extracting properties', () => extractProps(config, customState, stockSrc))
    }

    // 7. SELinux policies
    let sepolicyResolutions: SelinuxPartResolutions | null = null
    if (config.generate.sepolicy_dirs) {
      sepolicyResolutions = await withSpinner('Adding missing SELinux policies', () =>
        resolveSepolicyDirs(config, customState, dirs, stockSrc),
      )
    }

    // 8. Overlays
    if (config.generate.overlays) {
      let overlayPkgs = await withSpinner('Extracting overlays', spinner =>
        extractOverlays(spinner, config, customState, dirs, aapt2Path, stockSrc),
      )
      buildPkgs.push(...overlayPkgs)
    }

    // 9. vintf manifests
    let vintfManifestPaths: Map<string, string> | null = null
    if (config.generate.vintf) {
      vintfManifestPaths = await withSpinner('Extracting vintf manifests', () =>
        extractVintfManifests(customState, dirs, stockSrc),
      )
    }

    // 10. Firmware
    let fwPaths: Array<string> | null = null
    if (config.generate.factory_firmware && factoryPath != undefined) {
      if (propResults == null) {
        throw new Error('Factory firmware extraction depends on properties')
      }

      fwPaths = await withSpinner('Extracting firmware', () =>
        extractFirmware(config, dirs, propResults!.stockProps, factoryPath!),
      )
    }

    let vendorLinkerConfig = config.platform.vendor_linker_config
    let vendorLinkerConfigPath: string | null = null
    if (Object.keys(vendorLinkerConfig).length > 0) {
      let json = JSON.stringify(vendorLinkerConfig, null, 4)
      vendorLinkerConfigPath = path.join(dirs.proprietary, 'linker-config-adevtool.json')
      await fs.writeFile(vendorLinkerConfigPath, json)
    }

    // 11. Build files
    await withSpinner('Generating build files', () =>
      generateBuildFiles(
        config,
        dirs,
        entries,
        buildPkgs,
        propResults,
        fwPaths,
        vintfManifestPaths,
        vendorLinkerConfigPath,
        sepolicyResolutions,
        stockSrc,
      ),
    )

    await Promise.all([writeEnvsetupCommands(config, dirs), writeReadme(config, dirs, propResults)])
  })

export default class GenerateFull extends Command {
  static description = 'generate all vendor parts automatically'

  static flags = {
    help: Flags.help({ char: 'h' }),
    aapt2: Flags.string({
      char: 'a',
      description: 'path to aapt2 executable',
      default: 'out/host/linux-x86/bin/aapt2',
    }),
    customSrc: Flags.string({
      char: 'c',
      description: 'path to AOSP build output directory (out/) or (directory containing) JSON state file',
      default: COLLECTED_SYSTEM_STATE_DIR,
    }),
    factoryPath: Flags.string({
      char: 'f',
      description: 'path to stock factory images zip (for extracting firmware if stockSrc is not factory images)',
    }),
    otaPath: Flags.string({
      char: 'o',
      description: 'path to OTA image, used only for extract_android_ota_payload.py',
    }),
    skipCopy: Flags.boolean({
      char: 'k',
      description: 'skip file copying and only generate build files',
      default: false,
    }),
    parallel: Flags.boolean({
      char: 'p',
      description: 'generate devices in parallel (causes buggy progress spinners)',
      default: false,
    }),

    skipOtaExtraction: Flags.boolean({
      description:
        'skip extract_android_ota_payload.py step. Allows to skip downloading OTA image when OTA generation is not needed',
    }),

    updateSpec: Flags.boolean({
      description:
        'update vendor module FileTreeSpec in vendor-specs/ instead of requiring it to be equal to the reference (current) spec',
    }),

    doNotReplaceCarrierSettings: Flags.boolean({
      description: `do not replace carrier settings with updated ones from ${CARRIER_SETTINGS_DIR}`,
    }),

    ...WRAPPED_SOURCE_FLAGS,
    ...DEVICE_CONFIG_FLAGS,
  }

  static {
    GenerateFull.flags.stockSrc.required = false
  }

  async run() {
    let { flags } = await this.parse(GenerateFull)

    let devices = await loadDeviceConfigs(flags.devices)

    let images: Map<DeviceBuildId, DeviceImages>

    let useImagesFromConfig = flags.stockSrc === undefined

    if (useImagesFromConfig) {
      let requiredImageTypes = flags.skipOtaExtraction ? [ImageType.Factory] : [ImageType.Factory, ImageType.Ota]

      let index: BuildIndex = await loadBuildIndex()
      images = await prepareDeviceImages(index, requiredImageTypes, devices)
      assert(flags.otaPath === undefined)
      assert(flags.buildId === undefined)
      assert(flags.factoryPath === undefined)
      assert(!flags.useTemp)
    } else {
      if (!flags.skipOtaExtraction) {
        assert(flags.otaPath !== undefined, '--otaPath is not specified and --skipOtaExtraction is not set')
      }
    }

    await forEachDevice(
      devices,
      flags.parallel,
      async config => {
        let deviceBuildId: string | undefined
        let otaPath: string | undefined
        let stockSrc: string
        let factoryPath: string | undefined
        if (useImagesFromConfig) {
          let deviceImages = images.get(getDeviceBuildId(config))!
          stockSrc = deviceImages.unpackedFactoryImageDir
          factoryPath = deviceImages.factoryImage.getPath()
          let otaImage = deviceImages.otaImage
          if (otaImage !== undefined) {
            otaPath = otaImage.getPath()
          } else {
            assert(flags.skipOtaExtraction)
          }
        } else {
          stockSrc = flags.stockSrc!
          factoryPath = flags.factoryPath
          deviceBuildId = flags.buildId
          otaPath = flags.otaPath
        }

        // Prepare output directories
        let vendorDirs = await createVendorDirs(config.device.vendor, config.device.name)

        await doDevice(
          vendorDirs,
          config,
          stockSrc,
          flags.customSrc,
          flags.aapt2,
          deviceBuildId,
          factoryPath,
          flags.skipCopy,
          flags.useTemp,
        )

        if (!flags.skipOtaExtraction) {
          this.log(chalk.bold('Running extract_android_ota_payload.py'))
          // TODO: extract these files from bootloader.img instead of from full OTA image
          let cmd = path.join(ADEVTOOL_DIR, 'external/extract_android_ota_payload/extract_android_ota_payload.py')
          await spawnAsync(cmd, [otaPath!, vendorDirs.firmware])
        }

        if (!flags.doNotReplaceCarrierSettings) {
          if (flags.updateSpec && config.device.has_cellular) {
            this.log(chalk.bold(`Downloading carrier settings updates`))
            const csUpdateConfig = await fetchUpdateConfig(config.device.name, config.device.build_id, false)
            await downloadAllConfigs(csUpdateConfig, getCarrierSettingsUpdatesDir(config), false)
          }

          const srcCsDir = getCarrierSettingsUpdatesDir(config)
          const dstCsDir = getCarrierSettingsVendorDir(vendorDirs)
          if (await exists(srcCsDir)) {
            this.log(chalk.bold(`Updating carrier settings from ${path.relative(OS_CHECKOUT_DIR, srcCsDir)}`))
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
                console.log(`skipping copying ${file} due to older version (${srcVer}<${dstVer})`)
                continue
              }
              const destFile = path.join(dstCsDir, path.basename(file))
              await fs.rm(destFile, { force: true })
              await fs.copyFile(file, destFile)
            }
          }
        }

        if (flags.updateSpec) {
          let cpSkelPromise = copyVendorSkel(vendorDirs, config)
          await writeVendorFileTreeSpec(vendorDirs, config)
          await cpSkelPromise
          await decodeConfigs(
            getCarrierSettingsVendorDir(vendorDirs),
            path.join(getVendorModuleSkelDir(config), 'proprietary', CARRIER_SETTINGS_FACTORY_PATH),
          )
        } else {
          try {
            await compareToReferenceFileTreeSpec(vendorDirs, config)
          } catch (e) {
            await fs.rm(vendorDirs.out, { recursive: true })
            throw e
          }
        }
      },
      config => config.device.name,
    )
  }
}

async function compareToReferenceFileTreeSpec(vendorDirs: VendorDirectories, config: DeviceConfig) {
  console.log(chalk.bold('Verifying FileTreeSpec'))

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
    if (OVERRIDDEN_SKEL_EXTS.has(path.extname(skelFile))) {
      skelFile += SOONG_IGNORE_EXT
    }
    if (await exists(skelFile)) {
      gitDiffs.push(gitDiff(skelFile, path.resolve(vendorDirs.out, changedEntry)))
    }
  }

  for await (let diff of gitDiffs) {
    console.log(diff)
  }

  if (cmp.changedEntries.length > 0) {
    console.log(chalk.bold('\nChanged entries:'))
    for (let e of cmp.changedEntries) {
      console.log(e + ': ' + cmp.a.get(e) + ' -> ' + cmp.b.get(e))
    }
  }

  if (cmp.newEntries.size > 0) {
    console.log(chalk.bold(`\nNew entries:`))
    for (let [k, v] of cmp.newEntries) {
      console.log(k + ': ' + v)
    }
  }

  if (cmp.missingEntries.size > 0) {
    console.log(chalk.bold('\nMissing entries:'))
    for (let [k, v] of cmp.missingEntries) {
      console.log(k + ': ' + v)
    }
  }

  if (cmp.numDiffs() != 0) {
    console.log('\n')
    throw new Error(`Vendor module for ${
      config.device.name
    } doesn't match its FileTreeSpec in ${getVendorModuleTreeSpecFile(config)}.
To update it, use the --${GenerateFull.flags.updateSpec.name} flag.`)
  }
}

async function writeVendorFileTreeSpec(dirs: VendorDirectories, config: DeviceConfig) {
  let fileTreeSpec = getFileTreeSpec(dirs.out)

  let dstFile = getVendorModuleTreeSpecFile(config)
  await fs.mkdir(path.parse(dstFile).dir, { recursive: true })
  await fs.writeFile(dstFile, fileTreeSpecToYaml(await fileTreeSpec))
}

// see readme in vendor-skels/ dir
async function copyVendorSkel(dirs: VendorDirectories, config: DeviceConfig) {
  let skelDir = getVendorModuleSkelDir(config)

  let copyOptions = {
    errorOnExist: true,
    force: false,
    preserveTimestamps: false,
    recursive: true,
    filter(source: string): boolean {
      if (source.endsWith('.img')) {
        return false
      }

      if (source.startsWith(dirs.proprietary)) {
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

  await fs.rm(skelDir, { force: true, recursive: true })
  await fs.cp(dirs.out, skelDir, copyOptions)

  let renames: Promise<void>[] = []

  for await (let file of listFilesRecursive(skelDir)) {
    let ext = path.extname(file)
    if (OVERRIDDEN_SKEL_EXTS.has(ext)) {
      renames.push(fs.rename(file, file + SOONG_IGNORE_EXT))
    }
  }
  await Promise.all(renames)
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

// soong detects .bp, .mk files everywhere in OS checkout dir, add '.skip' suffix to the ones in vendor-skels/ dir
const OVERRIDDEN_SKEL_EXTS = new Set(['.bp', '.mk'])
const SOONG_IGNORE_EXT = '.skip'
