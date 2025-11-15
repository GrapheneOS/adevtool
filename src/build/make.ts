import assert from 'assert'
import { promises as fs } from 'fs'
import path, { basename, dirname } from 'path'
import { Reader } from 'protobufjs'
import { getVersionCheckFilePath, VendorDirectories } from '../blobs/build'
import { BlobEntry } from '../blobs/entry'
import { PartPath } from '../blobs/file-list'
import { DeviceConfig } from '../config/device'
import { RELATIVE_ADEVTOOL_PATH } from '../config/paths'
import { SystemState } from '../config/system-state'
import { PropResults } from '../frontend/generate'
import { MKBOOTIMG_ARGS_FILE_NAME } from '../frontend/source'
import { generateAndroidInfo } from '../images/firmware'
import { processSystemServerClassPaths } from '../processor/classpath'
import { SepolicyDirs } from '../processor/sepolicy'
import { VintfPaths } from '../processor/vintf'
import { LinkerConfig } from '../proto-ts/build/soong/linkerconfig/proto/linker_config'
import { assertDefined, mapGet } from '../util/data'
import { EntryFilterCmd, filterEntries } from '../util/exact-filter'
import { isFile, readFile } from '../util/fs'
import { MAKEFILE_HEADER } from '../util/headers'
import { Partition, PathResolver } from '../util/partitions'

const CONT_SEPARATOR = ' \\\n    '

const SEPOLICY_PARTITION_VARS: { [part: string]: string } = {
  system_ext: 'SYSTEM_EXT_PRIVATE_SEPOLICY_DIRS',
  product: 'PRODUCT_PRIVATE_SEPOLICY_DIRS',
  vendor: 'BOARD_VENDOR_SEPOLICY_DIRS',
  odm: 'BOARD_ODM_SEPOLICY_DIRS',
}

const SEPOLICY_PUBLIC_PARTITION_VARS: { [part: string]: string } = {
  system_ext: 'SYSTEM_EXT_PUBLIC_SEPOLICY_DIRS',
  product: 'PRODUCT_PUBLIC_SEPOLICY_DIRS',
}

const VINTF_COMPAT_MATRIX_VARS: { [part: string]: string } = {
  system: 'DEVICE_FRAMEWORK_COMPATIBILITY_MATRIX_FILE',
  product: 'DEVICE_PRODUCT_COMPATIBILITY_MATRIX_FILE',
  vendor: 'DEVICE_MATRIX_FILE',
}

const VINTF_MANIFEST_PARTITION_VARS: { [part: string]: string } = {
  system: 'DEVICE_FRAMEWORK_MANIFEST_FILE',
  system_ext: 'SYSTEM_EXT_MANIFEST_FILES',
  product: 'PRODUCT_MANIFEST_FILES',
  vendor: 'DEVICE_MANIFEST_FILE', // no 'S'
  odm: 'ODM_MANIFEST_FILES',
}

export interface Symlink {
  moduleName: string
  linkPartPath: PartPath
  targetPath: string
}

function startBlocks() {
  return [MAKEFILE_HEADER]
}

function finishBlocks(blocks: Array<string>) {
  return `${blocks.join('\n\n')}\n`
}

export function sanitizeBasename(path: string) {
  return basename(path).replaceAll(/[^a-z0-9_\-.]/g, '_')
}

function partPathToMakePath(pp: PartPath) {
  let copyPart = pp.partition === Partition.System ? 'PRODUCT_OUT' : `TARGET_COPY_OUT_${pp.partition.toUpperCase()}`
  let relPath = pp.relPath
  switch (pp.partition) {
    case Partition.Recovery:
      relPath = path.join('root', relPath)
      break
    case Partition.VendorRamdisk:
      relPath = path.join('first_stage_ramdisk', relPath)
      break
  }
  return `$(${copyPart})/${relPath}`
}

export function blobToFileCopy(entry: BlobEntry, proprietaryDir: string) {
  let destPath = partPathToMakePath(entry.partPath)
  return `${proprietaryDir}/${entry.partPath.asPseudoPath()}:${destPath}`
}

export async function genModulesMakefile(
  config: DeviceConfig,
  symlinks: Symlink[],
  fwPaths: string[] | null,
  dirs: VendorDirectories,
) {
  let blocks = startBlocks()
  blocks.push('LOCAL_PATH := $(call my-dir)', `ifeq ($(TARGET_DEVICE),${config.device.name})`)

  if (fwPaths !== null) {
    // TODO specify images exactly
    blocks.push(`RADIO_FILES := $(wildcard $(LOCAL_PATH)/firmware/*.img)
$(foreach f, $(notdir $(RADIO_FILES)),$(call add-radio-file,firmware/$(f)))`)
  }

  if (symlinks.length > 0) {
    let mkdirCmds = new Set<string>()
    let linkCmds = []
    for (let link of symlinks) {
      let destPath = `$(PRODUCT_OUT)/${link.linkPartPath.partition}/${link.linkPartPath.relPath}`
      mkdirCmds.add(`mkdir -p ${dirname(destPath)};`)
      linkCmds.push(`ln -sf ${link.targetPath} ${destPath};`)
    }

    blocks.push(`include $(CLEAR_VARS)
LOCAL_MODULE := device_symlinks
LOCAL_MODULE_CLASS := ETC
LOCAL_MODULE_TAGS := optional
LOCAL_MODULE_OWNER := ${config.device.vendor}
LOCAL_MODULE_PATH := $(TARGET_OUT_VENDOR_ETC)
LOCAL_MODULE_STEM := .device_symlinks
LOCAL_SRC_FILES := Android.mk
LOCAL_POST_INSTALL_CMD := \\
    ${Array.from(mkdirCmds).join(CONT_SEPARATOR)} \\
    ${linkCmds.join(CONT_SEPARATOR)}
include $(BUILD_PREBUILT)`)
  }

  blocks.push('endif')
  await fs.writeFile(path.join(dirs.out, 'Android.mk'), finishBlocks(blocks))
}

function addBlock(blocks: Array<string>, block: Array<string>) {
  if (block.length > 0) {
    blocks.push(block.join('\n'))
  }
}

function addContBlock(blocks: Array<string>, variable: string, items: Array<string> | undefined) {
  if (items !== undefined && items.length > 0) {
    blocks.push(`${variable} += \\
    ${items.map(i => i.replaceAll('"', '\\"')).join(CONT_SEPARATOR)}`)
  }
}

export interface BuildSystemPackages {
  type: string
  names: string[]
}

export async function genProductMakefile(
  config: DeviceConfig,
  packages: BuildSystemPackages[],
  copyFiles: string[],
  vintfPathsMap: Map<string, VintfPaths> | null,
  propResults: PropResults,
  dirs: VendorDirectories,
  pathResolver: PathResolver,
  customState: SystemState | null,
) {
  let blocks = startBlocks()

  blocks.push(`include ${getVersionCheckFilePath(dirs)}`)

  let buildId = config.device.build_id
  blocks.push(`ifneq ($(BUILD_ID),${buildId})
  $(error BUILD_ID: expected ${buildId}, got $(BUILD_ID))
endif`)

  let splOverride = config.device.platform_security_patch_level_override
  if (splOverride !== undefined) {
    blocks.push(`ifneq ($(PLATFORM_SECURITY_PATCH),${splOverride})
  $(error PLATFORM_SECURITY_PATCH: expected ${splOverride}, got $(PLATFORM_SECURITY_PATCH))
endif`)
  }

  blocks.push(
    `$(call inherit-product, ${path.join(
      RELATIVE_ADEVTOOL_PATH,
      'config/mk',
      config.device.vendor,
      'device',
      config.device.name,
      'device.mk',
    )})`,
  )

  for (let mk of config.platform.extra_product_makefiles) {
    blocks.push(`include ${mk}`)
  }

  blocks.push('PRODUCT_SOONG_NAMESPACES += ' + dirs.out)

  let productProps = mapGet(propResults.stockProps, Partition.Product)

  let productName = mapGet(productProps, 'ro.product.product.name')
  if (productName.endsWith('_beta')) {
    productName = productName.slice(0, -'_beta'.length)
  }

  blocks.push(`PRODUCT_NAME := ${productName}
PRODUCT_DEVICE := ${productName}
PRODUCT_MODEL := ${mapGet(productProps, 'ro.product.product.model')}
PRODUCT_BRAND := ${mapGet(productProps, 'ro.product.product.brand')}
PRODUCT_MANUFACTURER := ${mapGet(productProps, 'ro.product.product.manufacturer')}`)

  let propConfigs: string[] = []

  let attestationProps = ['brand', 'device', 'manufacturer', 'model', 'name']
  for (let name of attestationProps) {
    let k = `ro.product.${name}_for_attestation`
    let v = productProps.get(k)
    if (v !== undefined) {
      propConfigs.push(`PRODUCT_${name.toUpperCase()}_FOR_ATTESTATION := ${v}`)
    }
  }

  let propMap = new Map<string, [string, string][]>()
  propMap.set(Partition.Vendor, [
    ['PRODUCT_SHIPPING_API_LEVEL', 'ro.product.first_api_level'],
    ['TARGET_BOOTLOADER_BOARD_NAME', 'ro.product.board'],
    ['TARGET_SCREEN_DENSITY', 'ro.sf.lcd_density'],
  ])

  for (let [part, props] of propMap) {
    let partProps = propResults.stockProps.get(part)
    if (partProps === undefined) {
      // TODO should no longer be needed after all state is regened
      continue
    }
    for (let [k, v] of props) {
      let value = partProps.get(v)
      if (value === undefined) {
        continue
      }
      propConfigs.push(makeKvLine(k, value))
    }
  }

  addBlock(blocks, propConfigs)

  let vendorProps = mapGet(propResults.stockProps, Partition.Vendor)
  const recoveryMinUiPrefix = 'ro.minui.'
  let collator = new Intl.Collator()

  let recoveryConfigs: string[] = []
  Array.from(vendorProps.entries())
    .filter(([k]) => k.startsWith(recoveryMinUiPrefix))
    .sort(([a], [b]) => collator.compare(a, b))
    .forEach(([k, v]) => {
      let name = k.substring(recoveryMinUiPrefix.length)
      recoveryConfigs.push(makeKvLine('TARGET_RECOVERY_' + name.toUpperCase(), v))
    })

  let recoveryProps = mapGet(propResults.stockProps, Partition.Recovery)

  const recoveryUiPrefix = 'ro.recovery.ui.'
  Array.from(recoveryProps.entries())
    .filter(([k]) => k.startsWith(recoveryUiPrefix))
    .sort(([a], [b]) => collator.compare(a, b))
    .forEach(([k, v]) => {
      let name = k.substring(recoveryUiPrefix.length)
      recoveryConfigs.push(makeKvLine('TARGET_RECOVERY_UI_' + name.toUpperCase(), v))
    })

  let recoveryFstab = path.join(dirs.proprietary, 'recovery/system/etc/recovery.fstab')
  if (await isFile(recoveryFstab)) {
    recoveryConfigs.push(makeKvLine('TARGET_RECOVERY_FSTAB', recoveryFstab))
  }
  let recoveryWipe = path.join(dirs.proprietary, 'recovery/system/etc/recovery.wipe')
  if (await isFile(recoveryWipe)) {
    recoveryConfigs.push(makeKvLine('TARGET_RECOVERY_WIPE', recoveryWipe))
  }

  addBlock(blocks, recoveryConfigs)

  if (vintfPathsMap !== null) {
    for (let [partition, vintfPaths] of vintfPathsMap.entries()) {
      let cmVar = VINTF_COMPAT_MATRIX_VARS[partition]
      if (cmVar === undefined) {
        assert(vintfPaths.compatMatrices.length === 0)
      } else {
        addContBlock(blocks, cmVar, vintfPaths.compatMatrices)
      }
      if (vintfPaths.baseManifestFile !== null) {
        blocks.push(assertDefined(VINTF_MANIFEST_PARTITION_VARS[partition]) + ' += ' + vintfPaths.baseManifestFile)
      }
      addContBlock(blocks, `# ${partition} vintf_fragments\nPRODUCT_PACKAGES`, vintfPaths.manifestFragments)
    }
  }

  if (customState !== null) {
    let lines = await Promise.all(
      [Partition.Product, Partition.Vendor].map(async part => {
        let configPb = pathResolver.resolve(part, 'etc/linker.config.pb')
        if (!(await isFile(configPb))) {
          return null
        }
        let config = LinkerConfig.decode(Reader.create(await fs.readFile(configPb)))
        assert(config.permittedPaths.length === 0)
        assert(config.contributions.length === 0)
        assert(!config.visible)
        assert(config.requireLibs.length === 0)
        assert(config.contributions.length === 0)

        let provideLibs = config.provideLibs
        if (provideLibs.length === 0) {
          return null
        }

        let obj = {
          provideLibs,
        }

        let configJson = path.join(dirs.proprietary, `linker.config-${part}.json`)
        await fs.writeFile(configJson, JSON.stringify(obj, null, 4))
        return `PRODUCT_${part.toUpperCase()}_LINKER_CONFIG_FRAGMENTS += ${configJson}`
      }),
    )
    let block = lines.filter(l => l !== null).join('\n')
    if (block.length > 0) {
      blocks.push(block)
    }

    addContBlock(blocks, 'PRODUCT_SYSTEM_SERVER_JARS', await processSystemServerClassPaths(pathResolver, customState))
  }

  let missingProps = propResults.missingProps
  if (missingProps !== undefined) {
    let dirName = path.join(dirs.out, 'sysprop')
    await fs.mkdir(dirName)

    let writes: Promise<void>[] = []
    let propFiles: string[] = []
    for (let [partition, props] of missingProps.entries()) {
      if (props.size === 0 || partition === Partition.Recovery) {
        continue
      }
      let propLines = Array.from(props.entries())
        .sort()
        .map(([k, v]) => `${k}=${v}`)
      propLines.push('')
      let propFileName = partition + '.prop'

      writes.push(fs.writeFile(path.join(dirName, propFileName), propLines.join('\n')))

      propFiles.push(`TARGET_${partition.toUpperCase()}_PROP += ${path.join(dirName, propFileName)}`)
    }
    addBlock(blocks, propFiles)
    await Promise.all(writes)
  }

  for (let group of packages) {
    addContBlock(blocks, '# ' + group.type + '\nPRODUCT_PACKAGES', group.names)
  }

  addContBlock(blocks, 'PRODUCT_COPY_FILES', copyFiles)

  let file = finishBlocks(blocks)

  await Promise.all([
    genProductsMakefile(productName, dirs),
    fs.writeFile(path.join(dirs.out, productName + '.mk'), file),
  ])
}

export async function genBoardMakefile(
  config: DeviceConfig,
  sepolicyDirs: SepolicyDirs | null,
  propResults: PropResults,
  fwPaths: string[] | null,
  dirs: VendorDirectories,
  pathResolver: PathResolver,
  isForStateCollectionBuild: boolean,
) {
  let blocks = startBlocks()

  blocks.push(
    'include ' +
      path.join(
        RELATIVE_ADEVTOOL_PATH,
        'config/mk',
        config.device.vendor,
        'device',
        config.device.name,
        'BoardConfig-base.mk',
      ),
  )

  let systemFsType = config.device.system_fs_type

  let missingOtaParts = propResults.missingOtaParts

  // Build vendor?
  if (missingOtaParts.includes(Partition.Vendor)) {
    blocks.push(`BOARD_VENDORIMAGE_FILE_SYSTEM_TYPE := ${systemFsType}`)
  }

  // Build DLKM partitions?
  if (missingOtaParts.includes(Partition.VendorDlkm)) {
    blocks.push(`BOARD_USES_VENDOR_DLKMIMAGE := true
BOARD_VENDOR_DLKMIMAGE_FILE_SYSTEM_TYPE := ${systemFsType}
TARGET_COPY_OUT_VENDOR_DLKM := vendor_dlkm`)
  }
  if (missingOtaParts.includes(Partition.OdmDlkm)) {
    blocks.push(`BOARD_USES_ODM_DLKIMAGE := true
BOARD_ODM_DLKIMAGE_FILE_SYSTEM_TYPE := ${systemFsType}
TARGET_COPY_OUT_ODM_DLKM := odm_dlkm`)
  }

  for (let part of [Partition.VendorBoot, Partition.InitBoot]) {
    let filePath = path.join(pathResolver.basePath, part, MKBOOTIMG_ARGS_FILE_NAME)
    if (!(await isFile(filePath))) {
      continue
    }
    let keyValues = (await readFile(filePath)).split('\0')
    assert(keyValues[keyValues.length - 1] === '')
    assert(keyValues.length % 2 === 1)
    for (let i = 0; i < keyValues.length - 1; i += 2) {
      let k = keyValues[i]
      let v = keyValues[i + 1]
      switch (k) {
        case '--header_version': {
          switch (part) {
            case Partition.VendorBoot: {
              blocks.push('BOARD_BOOT_HEADER_VERSION := ' + v)
              blocks.push('BOARD_MKBOOTIMG_ARGS += --header_version $(BOARD_BOOT_HEADER_VERSION)')
              break
            }
            case Partition.InitBoot: {
              blocks.push('BOARD_INIT_BOOT_HEADER_VERSION := ' + v)
              blocks.push('BOARD_MKBOOTIMG_INIT_ARGS += --header_version $(BOARD_INIT_BOOT_HEADER_VERSION)')
              break
            }
          }
          break
        }
        case '--vendor_cmdline': {
          let args = []
          let idx = 0
          while (idx < v.length) {
            let end = v.indexOf(' ', idx)
            if (end < 0) {
              end = v.length
            }
            let quoteIdx = v.indexOf('"', idx)
            if (quoteIdx >= idx && quoteIdx < end) {
              let closingQuoteIdx = v.indexOf('"', quoteIdx + 1)
              assert(closingQuoteIdx > quoteIdx)
              end = v.indexOf(' ', closingQuoteIdx)
              if (end < 0) {
                end = v.length
              }
            }
            let arg = v.substring(idx, end)
            idx = end + 1
            args.push(arg)
          }

          let cmd = {
            entries: args,
            exclusions: new Set(config.kernel_cmdline_exclusions),
            inclusions: new Set(config.kernel_cmdline_inclusions),
            unknownEntriesMessagePrefix: 'included unknown kernel cmdline args',
            yamlPath: [''],
          } as EntryFilterCmd

          addContBlock(blocks, 'BOARD_KERNEL_CMDLINE', filterEntries(cmd))
          break
        }
        default:
          break
      }
    }
  }

  let filePath = path.join(pathResolver.basePath, 'vendor_boot/bootconfig')
  if (await isFile(filePath)) {
    let res = (await readFile(filePath)).split('\n')
    if (res[res.length - 1] === '') {
      res = res.slice(0, -1)
    }
    addContBlock(blocks, 'BOARD_BOOTCONFIG', res)
  }

  if (!isForStateCollectionBuild) {
    addContBlock(blocks, 'AB_OTA_PARTITIONS', missingOtaParts)
  }

  if (fwPaths !== null) {
    // Generate android-info.txt from device and versions
    let androidInfo = generateAndroidInfo(config.device.name, propResults.stockProps)
    let androidInfoPath = path.join(dirs.firmware, 'android-info.txt')
    await fs.writeFile(androidInfoPath, androidInfo)
    blocks.push(makeKvLine('TARGET_BOARD_INFO_FILE', androidInfoPath))
  }

  if (sepolicyDirs !== null) {
    let lines: string[] = []
    for (let [part, sepolicyDir] of Object.entries(sepolicyDirs.dirs)) {
      lines.push(assertDefined(SEPOLICY_PARTITION_VARS[part]) + ' += ' + sepolicyDir)
    }
    for (let [part, sepolicyDir] of Object.entries(sepolicyDirs.publicDirs)) {
      lines.push(assertDefined(SEPOLICY_PUBLIC_PARTITION_VARS[part]) + ' += ' + sepolicyDir)
    }
    lines.push('SELINUX_IGNORE_NEVERALLOWS := true')
    addBlock(blocks, lines)
  }

  blocks.push(
    '# BUILD_BROKEN_DUP_RULES is needed for overriding AOSP-available files with extracted prebuilts\n' +
      'BUILD_BROKEN_DUP_RULES := true',
  )

  await fs.writeFile(path.join(dirs.out, 'BoardConfig.mk'), finishBlocks(blocks))
}

export async function genProductsMakefile(productName: string, dirs: VendorDirectories) {
  let blocks = startBlocks()
  blocks.push(`PRODUCT_MAKEFILES += $(LOCAL_DIR)/${productName}.mk`)
  await fs.writeFile(path.join(dirs.out, 'AndroidProducts.mk'), finishBlocks(blocks))
}

function makeKvLine(k: string, v: string) {
  return `${k} := ${v}`
}
