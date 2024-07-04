import { Flags } from '@oclif/core'
import assert from 'assert'
import { createReadStream, promises as fs } from 'fs'
import { FileHandle, FileReadOptions } from 'fs/promises'
import hasha from 'hasha'
import ora from 'ora'
import path from 'path'
import { pipeline } from 'stream/promises'
import yauzl from 'yauzl-promise'
import { DeviceBuildId, DeviceConfig, FsType, getDeviceBuildId, resolveBuildId } from '../config/device'

import { IMAGE_DOWNLOAD_DIR } from '../config/paths'
import { BuildIndex, ImageType } from '../images/build-index'
import { DeviceImage } from '../images/device-image'
import { downloadMissingDeviceImages } from '../images/download'
import { maybePlural, withSpinner } from '../util/cli'
import { createSubTmp, exists, mount, TempState, withTempDir } from '../util/fs'
import { ALL_SYS_PARTITIONS } from '../util/partitions'
import { run, spawnAsyncNoOut } from '../util/process'
import { isSparseImage } from '../util/sparse'
import { listZipFiles } from '../util/zip'

export const WRAPPED_SOURCE_FLAGS = {
  stockSrc: Flags.string({
    char: 's',
    description:
      'path to (extracted) factory images, (mounted) images, (extracted) OTA package, OTA payload, or directory containing any such files (optionally under device and/or build ID directory)',
    required: true,
  }),
  buildId: Flags.string({
    char: 'b',
    description: 'stock OS build ID, defaults to build_id value from device config',
  }),
  useTemp: Flags.boolean({
    char: 't',
    description: 'use a temporary directory for all extraction (prevents reusing extracted files across runs)',
    default: false,
  }),
}

export interface WrappedSource {
  src: string | null
  factoryPath: string | null
}

async function containsParts(src: string, suffix = '') {
  // If any sys partitions are present
  for (let part of ALL_SYS_PARTITIONS) {
    let path = `${src}/${part}${suffix}`
    try {
      if (await exists(path)) {
        return true
      }
    } catch {
      // ENOENT
    }
  }

  return false
}

class SourceResolver {
  constructor(
    readonly device: string,
    readonly buildId: string | null,
    readonly useTemp: boolean,
    readonly tmp: TempState,
    readonly spinner: ora.Ora,
  ) {}

  // Dummy TempState that just returns the path, but with managed mountpoints
  private createStaticTmp(path: string) {
    return {
      ...this.tmp,
      dir: path,
    } as TempState
  }

  // Dynamically switch between static and real sub-temp, depending on useTemp
  private async createDynamicTmp(tmpPath: string, absPath: string) {
    if (this.useTemp) {
      return await createSubTmp(this.tmp, tmpPath)
    }
    return this.createStaticTmp(absPath)
  }

  private async mountImg(img: string, dest: string) {
    // Convert sparse image to raw
    if (await isSparseImage(img)) {
      this.spinner.text = `converting sparse image: ${img}`
      let sparseTmp = await this.createDynamicTmp(`sparse_img/${path.basename(path.dirname(img))}`, path.dirname(img))

      let rawImg = `${sparseTmp.dir}/${path.basename(img)}.raw`
      await run(`simg2img ${img} ${rawImg}`)
      await fs.rm(img)
      img = rawImg
    }

    this.spinner.text = `mounting: ${img}`
    await mount(img, dest)
    this.tmp.mounts.push(dest)
  }

  private async mountParts(src: string, mountTmp: TempState, suffix = '.img') {
    let mountRoot = mountTmp.dir

    for (let part of ALL_SYS_PARTITIONS) {
      let img = `${src}/${part}${suffix}`
      if (await exists(img)) {
        let partPath = `${mountRoot}/${part}`
        await fs.mkdir(partPath)
        await this.mountImg(img, partPath)
      }
    }
  }

  private async wrapLeafFile(file: string, factoryPath: string | null): Promise<WrappedSource> {
    let imagesTmp = await this.createDynamicTmp(`src_images/${path.basename(file)}`, path.dirname(file))

    // Extract images from OTA payload
    if (path.basename(file) == 'payload.bin') {
      this.spinner.text = `extracting OTA images: ${file}`
      await run(`cd ${imagesTmp.dir}; payload-dumper-go ${file}`)
      if (file.startsWith(this.tmp.dir)) {
        await fs.rm(file)
      }

      let extractedDir = (await fs.readdir(imagesTmp.dir))[0]
      let imagesPath = `${imagesTmp.dir}/${extractedDir}`
      return await this.searchLeafDir(imagesPath, factoryPath)
    }

    let files = await listZipFiles(file)

    let imagesEntry = files.find(f => f.includes('/image-') && f.endsWith('.zip'))
    if (imagesEntry != undefined) {
      // Factory images

      // Extract nested images zip
      this.spinner.text = `extracting factory images: ${file}`
      let imagesFile = `${imagesTmp.dir}/${imagesEntry}`
      await run(`unzip -od ${imagesTmp.dir} ${file}`)
      return await this.wrapLeafFile(imagesFile, file)
    }
    if (files.find(f => f == 'payload.bin') != undefined) {
      // OTA package

      // Extract update_engine payload
      this.spinner.text = `extracting OTA payload: ${file}`
      let payloadFile = `${imagesTmp.dir}/payload.bin`
      await run(`unzip -od ${imagesTmp.dir} ${file} payload.bin`)
      return await this.wrapLeafFile(payloadFile, factoryPath)
    }
    if (files.find(f => f.endsWith('.img') && ALL_SYS_PARTITIONS.has(f.replace('.img', '')))) {
      // Images zip

      // Extract image files
      this.spinner.text = `extracting images: ${file}`
      await run(`unzip -od ${imagesTmp.dir} ${file}`)
      if (file.startsWith(this.tmp.dir)) {
        await fs.rm(file)
      }
      return await this.searchLeafDir(imagesTmp.dir, factoryPath)
    }
    throw new Error(`File '${file}' has unknown format`)
  }

  private async searchLeafDir(src: string, factoryPath: string | null): Promise<WrappedSource> {
    if (!(await exists(src))) {
      return {
        src: null,
        factoryPath: null,
      }
    }

    if (await containsParts(src)) {
      // Root of mounted images
      return { src, factoryPath }
    }
    if (await containsParts(src, '.img.raw')) {
      // Mount raw images: <images>.img.raw

      // Mount the images
      let mountTmp = await createSubTmp(this.tmp, `sysroot/${path.basename(src)}`)
      await this.mountParts(src, mountTmp, '.img.raw')
      return { src: mountTmp.dir, factoryPath: factoryPath || src }
    }
    if (await containsParts(src, '.img')) {
      // Mount potentially-sparse images: <images>.img

      // Mount the images
      let mountTmp = await createSubTmp(this.tmp, `sysroot/${path.basename(src)}`)
      await this.mountParts(src, mountTmp)
      return { src: mountTmp.dir, factoryPath: factoryPath || src }
    }
    if (this.device != null && this.buildId != null) {
      let imagesZip = `${src}/image-${this.device}-${this.buildId}.zip`
      if (await exists(imagesZip)) {
        // Factory images - nested images package: image-$device-$buildId.zip
        return await this.wrapLeafFile(imagesZip, factoryPath || src)
      }

      let newFactoryPath = (await fs.readdir(src)).find(f => f.startsWith(`${this.device}-${this.buildId}-factory-`))
      if (newFactoryPath != undefined) {
        // Factory images zip
        return await this.wrapLeafFile(`${src}/${newFactoryPath}`, newFactoryPath)
      }
    }

    return {
      src: null,
      factoryPath: null,
    }
  }

  async wrapSystemSrc(src: string) {
    let stat = await fs.stat(src)
    if (stat.isDirectory()) {
      // Directory

      let tryDirs = [
        ...((this.buildId != null && [
          `${src}/${this.buildId}`,
          `${src}/${this.device}/${this.buildId}`,
          `${src}/${this.buildId}/${this.device}`,
        ]) ||
          []),
        `${src}/${this.device}`,
        src,
      ]

      // Also try to find extracted factory images first: device-buildId
      if (this.buildId != null) {
        tryDirs = [...tryDirs.map(p => `${p}/${this.device}-${this.buildId}`), ...tryDirs]
      }

      for (let dir of tryDirs) {
        let { src: wrapped, factoryPath } = await this.searchLeafDir(dir, null)
        if (wrapped != null) {
          this.spinner.text = wrapped.startsWith(this.tmp.dir) ? path.relative(this.tmp.dir, wrapped) : wrapped
          return { src: wrapped, factoryPath }
        }
      }

      throw new Error(`No supported source format found in '${src}'`)
    } else if (stat.isFile()) {
      // File

      // Attempt to extract factory images or OTA
      let { src: wrapped, factoryPath } = await this.wrapLeafFile(src, null)
      if (wrapped != null) {
        this.spinner.text = wrapped.startsWith(this.tmp.dir) ? path.relative(this.tmp.dir, wrapped) : wrapped
        return { src: wrapped, factoryPath }
      }
    }

    throw new Error(`Source '${src}' has unknown type`)
  }
}

export async function wrapSystemSrc(
  src: string,
  device: string,
  buildId: string | null,
  useTemp: boolean,
  tmp: TempState,
  spinner: ora.Ora,
): Promise<WrappedSource> {
  let resolver = new SourceResolver(device, buildId, useTemp, tmp, spinner)
  return await resolver.wrapSystemSrc(src)
}

export async function withWrappedSrc<Return>(
  stockSrc: string,
  device: string,
  buildId: string | undefined,
  useTemp: boolean,
  callback: (stockSrc: string) => Promise<Return>,
) {
  return await withTempDir(async tmp => {
    // Prepare stock system source
    let wrapBuildId = buildId == undefined ? null : buildId
    let wrapped = await withSpinner('Extracting stock system source', spinner =>
      wrapSystemSrc(stockSrc, device, wrapBuildId, useTemp, tmp, spinner),
    )
    let wrappedSrc = wrapped.src!

    return await callback(wrappedSrc)
  })
}

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
  let allImages: DeviceImage[] = []

  let imagesMap = new Map<DeviceBuildId, DeviceImages>()

  for (let deviceConfig of devices) {
    for (let type of types) {
      let buildIds = maybeBuildIds ?? [deviceConfig.device.build_id]

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
        allImages.push(deviceImage)
      }
    }
  }

  await downloadMissingDeviceImages(allImages)

  let jobs: Promise<unknown>[] = []
  let destinationDirNames: string[] = []

  for (let images of imagesMap.values()) {
    let factoryImage = images.factoryImage
    if (factoryImage === undefined) {
      continue
    }

    let dirName = getUnpackedFactoryDirName(images.factoryImage)
    let dir = path.join(IMAGE_DOWNLOAD_DIR, 'unpacked', dirName)
    images.unpackedFactoryImageDir = dir

    let isAlreadyUnpacked = false
    try {
      isAlreadyUnpacked = (await fs.stat(dir)).isDirectory()
    } catch {
      /* empty */
    }

    if (!isAlreadyUnpacked) {
      let factoryImagePath = images.factoryImage.getPath()
      destinationDirNames.push(dirName)
      jobs.push(unpackFactoryImage(factoryImagePath, factoryImage, dir))
    }
  }

  if (jobs.length > 0) {
    console.log(`Unpacking image${maybePlural(destinationDirNames)}: ${destinationDirNames.join(', ')}`)
    let label = 'Unpack completed in'
    console.time(label)
    await Promise.all(jobs)
    console.timeEnd(label)
  }

  return imagesMap
}

function getUnpackedFactoryDirName(image: DeviceImage) {
  return image.deviceConfig.device.name + '-' + image.buildId
}

async function unpackFactoryImage(factoryImagePath: string, image: DeviceImage, out: string) {
  assert(image.type === ImageType.Factory)

  let sha256 = await hasha.fromFile(factoryImagePath, { algorithm: 'sha256' })
  if (sha256 === image.sha256) {
    // There's a TOCTOU race (file is accessed after check), but it affects all other generated files too.
    // Fixing it for this particular case is not worth the complexity increase
  } else {
    if (image.skipSha256Check) {
      console.warn(`skipping SHA-256 check for ${image.fileName}, SHA-256: ${sha256}`)
    } else {
      throw new Error(`SHA-256 mismatch for '${image.fileName}': expected ${image.sha256} got ${sha256}`)
    }
  }

  let fd = await fs.open(factoryImagePath, 'r')
  try {
    let fdSize = (await fd.stat()).size
    let outerZip = await yauzl.fromReader(new FdReader(fd, 0, fdSize), fdSize)

    for await (let entryP of outerZip) {
      let entry: yauzl.Entry = entryP
      let entryName = entry.filename

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

      let unpackedTmp = out + '-tmp'
      let promises = []

      let rmTmpDir = false
      try {
        await fs.access(unpackedTmp)
        rmTmpDir = true
      } catch {
        /* empty */
      }

      if (rmTmpDir) {
        await spawnAsyncNoOut('chmod', ['--recursive', 'u+w', unpackedTmp])
        await fs.rm(unpackedTmp, { recursive: true, force: true })
      }

      await fs.mkdir(unpackedTmp, { recursive: true })

      let fsType = image.deviceConfig.device.system_fs_type

      for await (let innerEntry of innerZip) {
        promises.push(unpackFsImage(innerEntry, fsType, unpackedTmp))
      }

      await Promise.all(promises)

      // remove write access to prevent accidental modification of unpacked files
      await spawnAsyncNoOut('chmod', ['--recursive', 'a-w', unpackedTmp])

      await fs.rename(unpackedTmp, out)

      console.log('unpacked ' + getUnpackedFactoryDirName(image))
      return
    }
  } finally {
    await fd.close()
  }
}

async function unpackFsImage(entry: yauzl.Entry, fsType: FsType, unpackedTmpRoot: string) {
  let fsImageName = entry.filename

  let expectedExt = '.img'
  let ext = path.extname(fsImageName)
  if (ext !== expectedExt) {
    return
  }

  let fsImageBaseName = path.basename(fsImageName, expectedExt)

  if (!ALL_SYS_PARTITIONS.has(fsImageBaseName)) {
    return
  }

  // extract file system image file
  let readStream = await entry.openReadStream({ validateCrc32: false })
  let fsImagePath = path.join(unpackedTmpRoot, entry.filename)
  let writeStream = (await fs.open(fsImagePath, 'w')).createWriteStream()
  await pipeline(readStream, writeStream)

  let destinationDir = path.join(unpackedTmpRoot, fsImageBaseName)
  await fs.mkdir(destinationDir)

  if (fsType === FsType.EXT4) {
    await unpackExt4(fsImagePath, destinationDir)
  } else {
    assert(fsType === FsType.EROFS)
    await unpackErofs(fsImagePath, destinationDir)
  }

  await fs.rm(fsImagePath)
}

async function unpackExt4(fsImagePath: string, destinationDir: string) {
  // rdump uses " for quoting
  assert(!destinationDir.includes('"'), destinationDir)

  let isStderrLineAllowed = function (s: string) {
    return (
      s.length == 0 ||
      // it's expected that ownership information will be lost during unpacking
      s.startsWith('dump_file: Operation not permitted while changing ownership of ') ||
      s.startsWith('rdump: Operation not permitted while changing ownership of ') ||
      // version string
      s.startsWith('debugfs ')
    )
  }

  await spawnAsyncNoOut('debugfs', ['-R', `rdump / "${destinationDir}"`, fsImagePath], isStderrLineAllowed)
}

async function unpackErofs(fsImagePath: string, destinationDir: string) {
  await spawnAsyncNoOut('fsck.erofs', ['--extract=' + destinationDir, fsImagePath])
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
    // do not initialize buffer contnents, assert below ensures that it's fully written out
    let buffer = Buffer.allocUnsafe(length)

    let opts = {
      buffer,
      length,
      position: this.off + start,
    } as FileReadOptions

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
