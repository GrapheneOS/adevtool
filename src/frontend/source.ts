import assert from 'assert'
import { createReadStream, promises as fs, ReadOptionsWithBuffer } from 'fs'
import { FileHandle, FileReadOptions } from 'fs/promises'
import hasha from 'hasha'
import path from 'path'
import { pipeline } from 'stream/promises'
import yauzl from 'yauzl-promise'
import { DeviceBuildId, DeviceConfig, FsType, getDeviceBuildId, resolveBuildId } from '../config/device'
import { log, StatusLine } from '../util/log'

import { Semaphore } from 'async-mutex'
import * as zlib from 'node:zlib'
import { ADEVTOOL_DIR, getHostBinPath, IMAGE_DOWNLOAD_DIR, OS_CHECKOUT_DIR } from '../config/paths'
import { BuildIndex, ImageType } from '../images/build-index'
import { DeviceImage } from '../images/device-image'
import { downloadDeviceImage } from '../images/download'
import { exists, isDirectory, isFile, listFilesRecursive } from '../util/fs'
import { UNPACKABLE_BOOT_PARTITION_IMAGES, UNPACKABLE_PARTITION_IMAGES } from '../util/partitions'
import { spawnAsync, spawnAsyncNoOut } from '../util/process'

export interface DeviceImages {
  factoryImage: DeviceImage
  unpackedFactoryImageDir: string
  otaImage?: DeviceImage
  vendorImages?: Map<string, DeviceImage>
}

export async function prepareFactoryImages(buildIndex: BuildIndex, devices: DeviceConfig[], maybeBuildIds?: string[]) {
  return await prepareDeviceImages(buildIndex, [ImageType.Factory], devices, maybeBuildIds)
}

export async function prepareDeviceImages(
  buildIndex: BuildIndex,
  types: ImageType[],
  devices: DeviceConfig[],
  // if not specified, current build ID is used for each device
  maybeBuildIds?: string[],
) {
  let imagesMap = new Map<DeviceBuildId, DeviceImages>()

  for (let deviceConfig of devices) {
    for (let type of types) {
      let buildIds = maybeBuildIds
      if (buildIds === undefined) {
        buildIds = [deviceConfig.device.build_id]
        let backportBuildId = deviceConfig.device.backport_build_id
        if (backportBuildId !== undefined) {
          buildIds.push(backportBuildId)
        }
      }

      for (let buildIdSpec of buildIds) {
        let buildId = resolveBuildId(buildIdSpec, deviceConfig)
        let deviceImage = DeviceImage.get(buildIndex, deviceConfig, buildId, type)
        let deviceBuildId = getDeviceBuildId(deviceConfig, buildId)
        let images: DeviceImages = imagesMap.get(deviceBuildId) ?? ({} as DeviceImages)
        if (deviceImage.type === ImageType.Factory) {
          images.factoryImage = deviceImage
        } else if (deviceImage.type === ImageType.Ota) {
          images.otaImage = deviceImage
        } else {
          let map = images.vendorImages
          if (map === undefined) {
            map = new Map<string, DeviceImage>()
            images.vendorImages = map
          }
          map.set(deviceImage.type, deviceImage)
        }
        imagesMap.set(deviceBuildId, images)
      }
    }
  }

  let jobs = Array.from(imagesMap.values()).map(images =>
    (async () => {
      let imageToUnpack: DeviceImage | null = null
      if (images.factoryImage !== undefined && !images.factoryImage.isGrapheneOsImage()) {
        imageToUnpack = images.factoryImage
      } else if (images.otaImage !== undefined) {
        imageToUnpack = images.otaImage
      }

      if (imageToUnpack === null) {
        return
      }

      using statusLine = new StatusLine('')

      if (!(await imageToUnpack.isPresent())) {
        await downloadDeviceImage(imageToUnpack, statusLine)
      }

      let dirName = getUnpackedImageDirName(imageToUnpack)
      let dir = path.join(IMAGE_DOWNLOAD_DIR, 'unpacked', dirName)
      images.unpackedFactoryImageDir = dir

      if (await isDirectory(path.join(dir, BASE_FIRMWARE_DIR))) {
        return
      }

      if (unpackSemaphore.isLocked()) {
        statusLine.set('pending unpack of ' + imageToUnpack.toString())
      }

      await unpackSemaphore.runExclusive(async () => {
        statusLine.set('unpacking ' + imageToUnpack.toString())
        await unpackImage(imageToUnpack, dir)
      })
    })(),
  )
  await Promise.all(jobs)

  return imagesMap
}

async function deleteNonTempUnpackedImagesDir(destDir: string) {
  if (await isDirectory(destDir)) {
    await spawnAsyncNoOut('chmod', ['-R', 'u+w', destDir])
    await spawnAsyncNoOut('rm', ['-r', destDir])
  }
}

export async function deleteUnpackedDeviceImages(imagesMap: Map<DeviceBuildId, DeviceImages>) {
  for (const images of imagesMap.values()) {
    const dir = images.unpackedFactoryImageDir;
    if (!dir) {
      continue;
    }
    await deleteNonTempUnpackedImagesDir(dir);
  }
}

const unpackConcurrency = parseInt(process.env['ADEVTOOL_UNPACK_CONCURRENCY'] ?? '10')
const unpackSemaphore = new Semaphore(unpackConcurrency)

async function unpackImage(imageToUnpack: DeviceImage, destDir: string) {
  await deleteNonTempUnpackedImagesDir(destDir);

  let destTmpDir = destDir + '-tmp'

  if (await isDirectory(destTmpDir)) {
    await spawnAsyncNoOut('chmod', ['-R', 'u+w', destTmpDir])
    await fs.rm(destTmpDir, { recursive: true, force: true })
  }

  await fs.mkdir(destTmpDir, { recursive: true })

  if (imageToUnpack.type == ImageType.Factory) {
    await unpackFactoryImage(imageToUnpack.getPath(), imageToUnpack, destTmpDir)
  } else {
    assert(imageToUnpack.type === ImageType.Ota)
    await unpackOtaImage(imageToUnpack, destTmpDir)
  }

  // remove write access to prevent accidental modification of unpacked files
  await spawnAsyncNoOut('chmod', ['-R', 'a-w', destTmpDir])

  await fs.rename(destTmpDir, destDir)

  log('unpacked ' + getUnpackedImageDirName(imageToUnpack))
}

function getUnpackedImageDirName(image: DeviceImage) {
  return image.deviceConfig.device.name + '-' + image.buildId
}

export const BASE_FIRMWARE_DIR = 'base-firmware'

async function unpackFactoryImage(factoryImagePath: string, image: DeviceImage, out: string) {
  assert(image.type === ImageType.Factory)

  let sha256 = await hasha.fromFile(factoryImagePath, { algorithm: 'sha256' })
  if (sha256 === image.sha256) {
    // There's a TOCTOU race (file is accessed after check), but it affects all other generated files too.
    // Fixing it for this particular case is not worth the complexity increase
  } else {
    if (image.skipSha256Check) {
      log(`skipping SHA-256 check for ${image.fileName}, SHA-256: ${sha256}`)
    } else {
      throw new Error(`SHA-256 mismatch for '${image.fileName}': expected ${image.sha256} got ${sha256}`)
    }
  }

  let baseFwDir = path.join(out, BASE_FIRMWARE_DIR)
  await fs.mkdir(baseFwDir)

  let fd = await fs.open(factoryImagePath, 'r')
  try {
    let fdSize = (await fd.stat()).size
    let outerZip = await yauzl.fromReader(new FdReader(fd, 0, fdSize), fdSize)

    let jobs = []

    for await (let entryP of outerZip) {
      let entry: yauzl.Entry = entryP
      let entryName = entry.filename

      if (entryName.endsWith('.img')) {
        jobs.push(
          (async () => {
            let dstFilePath = path.join(baseFwDir, path.basename(entryName))
            await pipeline(await outerZip.openReadStream(entry), (await fs.open(dstFilePath, 'w')).createWriteStream())
          })(),
        )
        continue
      }

      let isInnerZip = false

      let deviceName = image.deviceConfig.device.name
      if (image.isGrapheneOS) {
        isInnerZip = entryName.includes(`/image-${deviceName}-`) && entryName.endsWith('.zip')
      } else {
        isInnerZip =
          entryName.includes(`-${image.buildId.toLowerCase()}/image-${deviceName}`) &&
          entryName.endsWith(`-${image.buildId.toLowerCase()}.zip`)
      }

      if (!isInnerZip) {
        continue
      }

      // this operation initializes entry.fileDataOffset
      ;(await outerZip.openReadStream(entry, { validateCrc32: false })).destroy()

      assert(entry.compressionMethod === 0, entryName) // uncompressed
      assert(entry.compressedSize === entry.uncompressedSize, entryName)

      let entryOffset = entry.fileDataOffset
      if (entryOffset === null) {
        throw Error('entryOffset is null')
      }

      let innerZip = await yauzl.fromReader(
        new FdReader(fd, entryOffset, entry.uncompressedSize),
        entry.uncompressedSize,
      )

      for await (let innerEntry of innerZip) {
        jobs.push(unpackFsImageZipEntry(innerEntry, out))
      }
    }
    await Promise.all(jobs)
  } finally {
    await fd.close()
  }
}

async function unpackOtaImage(image: DeviceImage, out: string) {
  let otaPath = image.getPath()

  let otaZip = await yauzl.open(otaPath)

  let payloadBinOffset: number | null = null

  try {
    for await (let entry of otaZip) {
      if (entry.filename === 'payload.bin') {
        // this operation initializes entry.fileDataOffset
        ;(await otaZip.openReadStream(entry, { validateCrc32: false })).destroy()

        let off = entry.fileDataOffset
        assert(off !== null, 'payload.bin fileDataOffset is null')
        payloadBinOffset = off
        break
      }
    }
  } finally {
    otaZip.close()
  }

  if (payloadBinOffset === null) {
    throw new Error('payloadBinOffset is null')
  }

  await spawnAsync(
    await getHostBinPath('ota_extractor'),
    ['-payload', otaPath, '-payload_offset', payloadBinOffset.toString(), '-output_dir', out],
    s => {
      return s.includes('INFO:ota_extractor.cc') || s.length === 0
    },
  )

  let jobs = []

  for (let fileName of await fs.readdir(out)) {
    let job = async () => {
      let file = path.resolve(out, fileName)
      if (await unpackFsImage(file, out)) {
        await fs.rm(file)
      }
    }
    jobs.push(job())
  }
  await Promise.all(jobs)
}

async function unpackApexes(unpackedPartitionDir: string, baseUnpackedImageDir: string) {
  let jobs: Promise<unknown>[] = []

  for await (let file of listFilesRecursive(unpackedPartitionDir)) {
    let extName = path.extname(file)
    if (!(extName === '.apex' || extName === '.capex')) {
      continue
    }

    let baseUnpackedApexesDir = path.join(baseUnpackedImageDir, UNPACKED_APEXES_DIR_NAME)
    let dirPath = path.join(baseUnpackedApexesDir, path.relative(baseUnpackedImageDir, file))

    jobs.push(unpackApex(file, dirPath))
  }

  await Promise.all(jobs)
}

export const MKBOOTIMG_ARGS_FILE_NAME = 'mkbootimg_args'

async function unpackApex(apexPath: string, dstPath: string) {
  await fs.mkdir(dstPath, { recursive: true })

  let fd = await fs.open(apexPath, 'r')
  try {
    let fdSize = (await fd.stat()).size
    let zip = await yauzl.fromReader(new FdReader(fd, 0, fdSize), fdSize)

    let unpacked = false

    for await (let entry of zip) {
      let name = entry.filename
      let isOriginalApex = name === 'original_apex'
      let isPayloadImg = name === 'apex_payload.img'
      if (!isOriginalApex && !isPayloadImg) {
        continue
      }
      let readStream = zip.openReadStream(entry, { validateCrc32: false })
      let unpackedEntry = path.join(dstPath, 'extracted__' + name)
      let writeStream = (await fs.open(unpackedEntry, 'w')).createWriteStream()
      await pipeline(await readStream, writeStream)
      if (isOriginalApex) {
        await unpackApex(unpackedEntry, dstPath)
      } else {
        await dumpFsImage(unpackedEntry, dstPath)
      }
      await fs.rm(unpackedEntry)
      unpacked = true
      break
    }

    if (!unpacked) {
      throw new Error('unable to unpack ' + apexPath)
    }
  } finally {
    await fd.close()
  }
}

async function unpackBootImage(fsImagePath: string, destinationDir: string) {
  let unpackBootimg = path.join(OS_CHECKOUT_DIR, 'system/tools/mkbootimg/unpack_bootimg.py')
  let imgInfo = await spawnAsync(unpackBootimg, [
    '--boot_img',
    fsImagePath,
    '--out',
    destinationDir,
    '--format',
    'mkbootimg',
    '--null',
  ])

  imgInfo = imgInfo.replaceAll(destinationDir + '/', '')

  let jobs: Promise<unknown>[] = []
  jobs.push(fs.writeFile(path.join(destinationDir, MKBOOTIMG_ARGS_FILE_NAME), imgInfo))

  for await (let file of listFilesRecursive(destinationDir)) {
    let basename = path.basename(file)
    if (!basename.includes('ramdisk')) {
      continue
    }
    let job = async () => {
      let stat = await fs.lstat(file)
      if (!stat.isFile() || stat.size === 0) {
        return
      }
      let dstDir = file + '__unpacked'
      await fs.mkdir(dstDir)
      await spawnAsync(
        path.join(ADEVTOOL_DIR, 'scripts/unpack-ramdisk.sh'),
        [await getHostBinPath('lz4'), await getHostBinPath('toybox'), file, dstDir],
        errLine => {
          switch (errLine) {
            case 'cpio: dev/console: Operation not permitted':
            case 'cpio: dev/kmsg: Operation not permitted':
            case 'cpio: dev/null: Operation not permitted':
            case 'cpio: dev/urandom: Operation not permitted':
            case '':
              return true
            default:
              return false
          }
        },
        undefined,
        [0, 1],
      )
    }
    jobs.push(job())
  }

  await Promise.all(jobs)
}

async function unpackFsImageZipEntry(entry: yauzl.Entry, unpackedTmpRoot: string) {
  let fsImageName = entry.filename

  let expectedExt = '.img'
  let ext = path.extname(fsImageName)
  if (ext !== expectedExt) {
    return
  }

  let fsImageBaseName = path.basename(fsImageName, expectedExt)

  if (!UNPACKABLE_PARTITION_IMAGES.has(fsImageBaseName)) {
    return
  }

  // extract file system image file
  let readStream = await entry.openReadStream({ validateCrc32: false })
  let fsImagePath = path.join(unpackedTmpRoot, entry.filename)
  let writeStream = (await fs.open(fsImagePath, 'w')).createWriteStream()
  await pipeline(readStream, writeStream)

  await unpackFsImage(fsImagePath, unpackedTmpRoot)
  await fs.rm(fsImagePath)
}

async function unpackFsImage(fsImagePath: string, baseDestinationDir: string) {
  let fsImageName = path.basename(fsImagePath)

  let expectedExt = '.img'
  let ext = path.extname(fsImageName)
  if (ext !== expectedExt) {
    return false
  }

  let fsImageBaseName = path.basename(fsImageName, expectedExt)

  if (!UNPACKABLE_PARTITION_IMAGES.has(fsImageBaseName)) {
    return false
  }

  let destinationDir = path.join(baseDestinationDir, fsImageBaseName)
  await fs.mkdir(destinationDir)

  if (UNPACKABLE_BOOT_PARTITION_IMAGES.has(fsImageBaseName)) {
    await unpackBootImage(fsImagePath, destinationDir)
    return true
  }

  await dumpFsImage(fsImagePath, destinationDir)

  // unpack compressed APKs
  await Promise.all(
    ['app', 'priv-app'].map(async appsDirName => {
      let appsDirPath = path.join(destinationDir, appsDirName)
      if (!(await isDirectory(appsDirPath))) {
        return
      }
      let jobs: Promise<void>[] = []
      for (let filePath of await Array.fromAsync(listFilesRecursive(appsDirPath))) {
        let suffix = '.apk.gz'
        if (!filePath.endsWith(suffix)) {
          //log(filePath)
          continue
        }
        jobs.push(
          (async () => {
            let parts = path.relative(destinationDir, filePath).split('/')
            assert(parts.length === 3, filePath)
            let fileName = parts[2]
            let appName = fileName.slice(0, -suffix.length)
            assert(parts[0] === appsDirName)
            assert(parts[1] === appName)

            // remove stub APK
            let appStubName = appName + '-Stub'
            let appStubDir = path.join(destinationDir, appsDirName, appStubName)
            let stubApk = path.join(appStubDir, appStubName + '.apk')
            assert(await isFile(stubApk))
            await fs.rm(stubApk)
            assert((await Array.fromAsync(listFilesRecursive(appStubDir))).length === 0)
            await fs.rmdir(appStubDir)

            let dstFilePath = filePath.slice(0, -'.gz'.length)
            assert(!(await exists(dstFilePath)), dstFilePath)

            await pipeline(
              (await fs.open(filePath, 'r')).createReadStream(),
              zlib.createGunzip(),
              (await fs.open(dstFilePath, 'w')).createWriteStream(),
            )
            await fs.rm(filePath)
          })(),
        )
      }
      await Promise.all(jobs)
    }),
  )

  await unpackApexes(destinationDir, baseDestinationDir)
  return true
}

export const UNPACKED_APEXES_DIR_NAME = 'unpacked_apexes'

export function getUnpackedApexesDir(images: DeviceImages) {
  return path.join(images.unpackedFactoryImageDir, UNPACKED_APEXES_DIR_NAME)
}

async function dumpFsImage(fsImagePath: string, destinationDir: string) {
  let fsType: FsType
  {
    let fh = await fs.open(fsImagePath, 'r')
    let buf = Buffer.alloc(0x40)
    try {
      await fh.read(buf, 0, buf.length, 0x400)
    } finally {
      await fh.close()
    }
    if (buf.readUint32LE(0) === 0xe0f5e1e2) {
      fsType = FsType.EROFS
    } else if (buf.readUint16LE(0x38) === 0xef53) {
      fsType = FsType.EXT4
    } else {
      throw new Error('unknown file system image ' + fsImagePath)
    }
  }
  if (fsType === FsType.EXT4) {
    await dumpExt4(fsImagePath, destinationDir)
  } else {
    assert(fsType === FsType.EROFS)
    await dumpErofs(fsImagePath, destinationDir)
  }
}

async function dumpExt4(fsImagePath: string, destinationDir: string) {
  // rdump uses " for quoting
  assert(!destinationDir.includes('"'), destinationDir)

  let isStderrLineAllowed = function (s: string) {
    return (
      s.length == 0 ||
      // it's expected that ownership information will be lost during unpacking
      s.startsWith('dump_file: Operation not permitted while changing ownership of ') ||
      s.startsWith('rdump: Operation not permitted while changing ownership of ') ||
      s.startsWith('rdump: Invalid argument while changing ownership of ') ||
      s.startsWith('dump_file: Invalid argument while changing ownership of ') ||
      // version string
      s.startsWith('debugfs ')
    )
  }

  await spawnAsyncNoOut(
    await getHostBinPath('debugfs'),
    ['-R', `rdump / "${destinationDir}"`, fsImagePath],
    isStderrLineAllowed,
  )
}

async function dumpErofs(fsImagePath: string, destinationDir: string) {
  await spawnAsyncNoOut(await getHostBinPath('fsck.erofs'), ['--extract=' + destinationDir, fsImagePath])
}

class FdReader extends yauzl.Reader {
  // fd ownership remains with the caller
  constructor(
    readonly fd: FileHandle,
    readonly off: number,
    readonly len: number,
  ) {
    super()
  }

  async _read(start: number, length: number) {
    // do not initialize buffer contents, assert below ensures that it's fully written out
    let buffer = Buffer.allocUnsafe(length)

    let opts: ReadOptionsWithBuffer<any> = {
      buffer: buffer,
      length: length,
      offset: 0,
      position: this.off + start,
    }

    assert((await this.fd.read(opts)).bytesRead === length)
    return buffer
  }

  _createReadStream(start: number, length: number) {
    // There's no way AFAIK to prevent closing of file descriptor when read stream ends, and node.js doens't have
    // a dup() wrapper. As a workaround, reopen the file by using /proc/self/fd reference
    return createReadStream(`/proc/self/fd/${this.fd.fd}`, {
      start: this.off + start,
      end: this.off + start + length - 1, // '-1' is needed because 'end' is inclusive
    })
  }
}
