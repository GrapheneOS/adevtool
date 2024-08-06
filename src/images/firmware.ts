import assert from 'assert'
import { promises as fs } from 'fs'
import * as unzipit from 'unzipit'

import { FastbootPack, EntryType } from './fastboot-pack'
import { PartitionProps } from '../blobs/props'
import { getAbOtaPartitions } from '../frontend/generate'
import { NodeFileReader } from '../util/zip'

export const ANDROID_INFO = 'android-info.txt'

export type FirmwareImages = Map<string, Buffer>

async function extractFactoryZipFirmware(path: string, images: FirmwareImages) {
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

async function extractFactoryDirFirmware(path: string, images: FirmwareImages) {
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
export async function extractFactoryFirmware(path: string, stockProps: PartitionProps) {
  let images: FirmwareImages = new Map<string, Buffer>()

  if ((await fs.stat(path)).isDirectory()) {
    await extractFactoryDirFirmware(path, images)
  } else {
    await extractFactoryZipFirmware(path, images)
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
  let android_info = `require board=${device}

require version-bootloader=${blVersion}
`
  if (radioVersion != undefined) {
    android_info += `require version-baseband=${radioVersion}\n`
  }

  if (stockAbOtaPartitions.includes('vendor_kernel_boot')) {
    android_info += 'require partition-exists=vendor_kernel_boot\n'
  }

  return android_info
}
