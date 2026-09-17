import assert from 'assert'
import { promises as fs } from 'fs'

import path from 'path'
import { BASEBAND_VERSION_PROP, BOOTLOADER_VERSION_PROP, PartitionProps } from '../blobs/props'
import { DeviceConfig } from '../config/device'
import { getAbOtaPartitions } from '../frontend/generate'
import { BASE_FIRMWARE_DIR } from '../frontend/source'
import { assertDefined, mapGet } from '../util/data'
import { Partition, PathResolver } from '../util/partitions'
import { EntryType, parseFastbootPack } from './fastboot-pack'

export type FirmwareImages = Map<string, Buffer>

function getBaseFirmwareDirPath(pathResolver: PathResolver, backport: boolean) {
  let root = backport ? assertDefined(pathResolver.overlay?.basePath) : pathResolver.basePath
  return path.join(root, BASE_FIRMWARE_DIR)
}

function getBaseFirmwareNameInfix(config: DeviceConfig, backport: boolean) {
  let isBeta = false
  if (config.device.backport_build_id === undefined) {
    isBeta = config.device.is_beta_build_id
  } else {
    if (config.device.is_beta_backport_build_id) {
      isBeta = backport
    }
  }
  return `-${config.device.name}${isBeta ? '_beta' : ''}-`
}

async function extractFactoryDirFirmware(
  config: DeviceConfig,
  stockProps: PartitionProps,
  pathResolver: PathResolver,
  images: FirmwareImages,
) {
  let vendorProps = mapGet(stockProps, Partition.Vendor)

  let blVersion = images.set(
    'bootloader.img',
    await fs.readFile(
      path.join(
        getBaseFirmwareDirPath(pathResolver, config.device.backport_bootloader_firmware),
        `bootloader${getBaseFirmwareNameInfix(config, config.device.backport_bootloader_firmware)}${mapGet(vendorProps, BOOTLOADER_VERSION_PROP)}.img`,
      ),
    ),
  )

  let basebandVersion = vendorProps.get(BASEBAND_VERSION_PROP)
  if (basebandVersion !== undefined) {
    images.set(
      'radio.img',
      await fs.readFile(
        path.join(
          getBaseFirmwareDirPath(pathResolver, config.device.backport_radio_firmware),
          `radio${getBaseFirmwareNameInfix(config, config.device.backport_radio_firmware)}${basebandVersion.toLowerCase()}.img`,
        ),
      ),
    )
  }
}

// Path can be a directory or zip
export async function extractFactoryFirmware(
  config: DeviceConfig,
  stockProps: PartitionProps,
  pathResolver: PathResolver,
) {
  let images: FirmwareImages = new Map<string, Buffer>()

  await extractFactoryDirFirmware(config, stockProps, pathResolver, images)

  let abPartitions = new Set(assertDefined(getAbOtaPartitions(stockProps)))

  // Extract partitions from firmware FBPKs (fastboot packs)
  for (let [, fbpkBuf] of Array.from(images.entries())) {
    let fastbootPack = parseFastbootPack(fbpkBuf)
    for (let entry of fastbootPack.entries) {
      if (abPartitions.has(entry.name)) {
        assert(entry.type === EntryType.PartitionData, `unexpected entry type: ${entry.type}`)
        images.set(entry.name + '.img', entry.readContents(fbpkBuf))
      }
    }
  }

  return images
}

export async function writeFirmwareImages(images: FirmwareImages, fwDir: string) {
  let paths = []
  let promises: Promise<void>[] = []
  for (let [name, buffer] of images.entries()) {
    let path = `${fwDir}/${name}`
    paths.push(path)
    promises.push(fs.writeFile(path, buffer))
  }
  await Promise.all(promises)

  return paths
}

export function generateAndroidInfo(device: string, stockProps: PartitionProps) {
  let vendorProps = mapGet(stockProps, Partition.Vendor)

  let android_info = `require board=${device}

require version-bootloader=${mapGet(vendorProps, BOOTLOADER_VERSION_PROP)}
`
  let radioVersion = vendorProps.get(BASEBAND_VERSION_PROP)
  if (radioVersion !== undefined) {
    android_info += `require version-baseband=${radioVersion}\n`
  }

  if (assertDefined(getAbOtaPartitions(stockProps)).includes('vendor_kernel_boot')) {
    android_info += 'require partition-exists=vendor_kernel_boot\n'
  }

  return android_info
}
