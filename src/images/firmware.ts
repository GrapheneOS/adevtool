import assert from 'assert'
import { promises as fs } from 'fs'
import * as unzipit from 'unzipit'

import { PartitionProps } from '../blobs/props'
import { getAbOtaPartitions } from '../frontend/generate'
import { NodeFileReader } from '../util/zip'
import { EntryType, FastbootPack } from './fastboot-pack'
import { DeviceConfig } from '../config/device'
import { deviceMapping } from '../config/hardcoded-config'

export const ANDROID_INFO = 'android-info.txt'

export type FirmwareImages = Map<string, Buffer>

async function extractFactoryZipFirmware(path: string, images: FirmwareImages, config: DeviceConfig) {
  await overrideFirmware(images, config)
  return;

  let reader = new NodeFileReader(path)

  try {
    let { entries } = await unzipit.unzip(reader)

    // Find images
    for (let [name, entry] of Object.entries(entries)) {
      if (name.includes('/bootloader-')) {
        images.set('bootloader.img', Buffer.from(await entry.arrayBuffer()))
      } else if (name.includes('/radio-')) {
        images.set('radio.img', Buffer.from(await entry.arrayBuffer()))
      }
    }
  } finally {
    await reader.close()
  }
}

async function overrideFirmware(images: FirmwareImages, config: DeviceConfig) {
  const firmwareDir = process.env.FIRMWARE_DIR;
  const hardcodedConfig = deviceMapping[`${config.device.name}`]

  if (!firmwareDir) {
    throw new Error('Value of FIRMWARE_DIR is not set')
  }

  if (hardcodedConfig['modem-name'] == "") {
    const loadedImages = await Promise.all(
      [
        fs.readFile(`${firmwareDir}/${hardcodedConfig['bootloader-name']}`)
      ]
    )
    images.set('bootloader.img', loadedImages[0])
  } else {
    const loadedImages = await Promise.all(
      [
        fs.readFile(`${firmwareDir}/${hardcodedConfig['bootloader-name']}`),
        fs.readFile(`${firmwareDir}/${hardcodedConfig['modem-name']}`)
      ]
    )
    images.set('bootloader.img', loadedImages[0])
    images.set('radio.img', loadedImages[1])
  }
}

async function extractFactoryDirFirmware(path: string, images: FirmwareImages, config: DeviceConfig) {

  await overrideFirmware(images, config)
  return;

  for (let file of await fs.readdir(path)) {
    if (file.startsWith('bootloader-')) {
      let buf = await fs.readFile(`${path}/${file}`)
      images.set('bootloader.img', buf)
    } else if (file.startsWith('radio-')) {
      let buf = await fs.readFile(`${path}/${file}`)
      images.set('radio.img', buf)
    }
  }
}

// Path can be a directory or zip
export async function extractFactoryFirmware(path: string, stockProps: PartitionProps, config: DeviceConfig) {
  let images: FirmwareImages = new Map<string, Buffer>()

  if ((await fs.stat(path)).isDirectory()) {
    await extractFactoryDirFirmware(path, images, config)
  } else {
    await extractFactoryZipFirmware(path, images, config)
  }

  let abPartitions = new Set(getAbOtaPartitions(stockProps)!)

  // Extract partitions from firmware FBPKs (fastboot packs)
  for (let [, fbpkBuf] of Array.from(images.entries())) {
    let fastbootPack = FastbootPack.parse(fbpkBuf)
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

export function generateAndroidInfo(
  device: string,
  blVersion: string,
  radioVersion: string,
  stockAbOtaPartitions: string[],
) {

  const hardcodedConfig = deviceMapping[`${device}`]
  const modem = hardcodedConfig['version-baseband']
  const bootloader = hardcodedConfig['version-bootloader']

  let android_info = `require board=${device}

require version-bootloader=${bootloader}
`
  if (modem != undefined) {
    android_info += `require version-baseband=${modem}\n`
  }

  if (stockAbOtaPartitions.includes('vendor_kernel_boot')) {
    android_info += 'require partition-exists=vendor_kernel_boot\n'
  }

  return android_info
}
