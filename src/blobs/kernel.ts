import assert from 'assert'
import { createWriteStream } from 'fs'
import * as fs from 'fs/promises'
import path from 'path'
import { pipeline } from 'stream/promises'
import { isDirectory, isFile } from '../util/fs'
import { log } from '../util/log'
import { Partition, PathResolver } from '../util/partitions'
import { VendorDirectories } from './build'

export const KERNEL_DIR_RELATIVE_PATH = 'stock-kernel'

export async function copyKernel(pathResolver: PathResolver, dirs: VendorDirectories) {
  let dstDir = path.join(dirs.out, KERNEL_DIR_RELATIVE_PATH)
  await fs.mkdir(dstDir)
  await copyKernelInner(pathResolver, dstDir)
}

export async function copyKernelInner(pathResolver: PathResolver, dstDir: string) {
  let copies: Promise<void>[] = []

  let imageLz4 = pathResolver.resolve(Partition.Boot, 'kernel')
  copies.push(fs.copyFile(imageLz4, path.join(dstDir, 'Image.lz4'), fs.constants.COPYFILE_EXCL))

  let vendorBootParitition = Partition.VendorKernelBoot
  if (!(await isDirectory(pathResolver.resolve(vendorBootParitition)))) {
    assert(await isDirectory(pathResolver.resolve(Partition.VendorBoot)))
    vendorBootParitition = Partition.VendorBoot
  }

  let dtb = pathResolver.resolve(vendorBootParitition, 'dtb')
  copies.push(fs.copyFile(dtb, path.join(dstDir, 'extracted.dtb'), fs.constants.COPYFILE_EXCL))

  {
    let dtboPath = path.join(pathResolver.basePath, 'dtbo.img')
    let dtboStat = await fs.stat(dtboPath)
    assert(dtboStat.isFile())
    let fileHandle = await fs.open(dtboPath, 'r')
    try {
      let buf = Buffer.alloc(4)
      let { bytesRead } = await fileHandle.read(buf, 0, 4, 4)
      assert(bytesRead === 4)
      let dtboSize = buf.readUInt32BE()
      assert(dtboSize > 8 && dtboSize < dtboStat.size, dtboPath)
      let srcStream = fileHandle.createReadStream({ start: 0, end: dtboSize - 1 })
      let dstStream = createWriteStream(path.join(dstDir, 'dtbo.img'))
      await pipeline(srcStream, dstStream)
    } finally {
      await fileHandle.close()
    }
  }
  {
    let srcDir = pathResolver.resolve(Partition.VendorDlkm, 'etc')
    for (let de of await fs.readdir(srcDir, { withFileTypes: true })) {
      if (!de.name.endsWith('.cfg')) {
        continue
      }
      assert(de.isFile(), de.name)
      let srcPath = path.join(srcDir, de.name)
      copies.push(fs.copyFile(srcPath, path.join(dstDir, de.name), fs.constants.COPYFILE_EXCL))
    }
  }

  for (let part of [
    ...(vendorBootParitition === Partition.VendorKernelBoot ? [Partition.SystemDlkm] : []),
    Partition.VendorDlkm,
    vendorBootParitition,
  ]) {
    let relPath
    switch (part) {
      case Partition.VendorKernelBoot:
        relPath = 'vendor_ramdisk00__unpacked/lib/modules'
        break
      case Partition.VendorBoot:
        relPath = 'vendor_ramdisk01__unpacked/lib/modules'
        break
      default:
        relPath = 'lib/modules'
    }
    let srcDir = pathResolver.resolve(part, relPath)
    for (let de of await fs.readdir(srcDir, { withFileTypes: true })) {
      if (de.isDirectory()) {
        assert(de.name === '16k' || de.name === '16k-mode', de.name)
        continue
      }
      assert(de.isFile(), de.name)
      let srcPath = path.join(srcDir, de.name)
      if (de.name.endsWith('.ko')) {
        let dstPath = path.join(dstDir, de.name)
        if (await isFile(dstPath)) {
          continue
        }
        await fs.copyFile(srcPath, dstPath, fs.constants.COPYFILE_EXCL)
        await fs.chmod(dstPath, 0o666)
      } else if (de.name === 'modules.load' || de.name == 'modules.blocklist') {
        let skipCopy = false
        if (part === vendorBootParitition && de.name === 'modules.load') {
          await fs.copyFile(srcPath, path.join(dstDir, de.name), fs.constants.COPYFILE_EXCL)
          skipCopy = part === Partition.VendorBoot
        }
        if (!skipCopy) {
          await fs.copyFile(srcPath, path.join(dstDir, part + '.' + de.name), fs.constants.COPYFILE_EXCL)
        }
      } else {
        switch (de.name) {
          case 'modules.alias':
          case 'modules.dep':
          case 'modules.softdep':
            // auto-generated files
            break
          default:
            log('copyKernel: unexpected file: ' + srcPath)
        }
      }
    }
  }
  await Promise.all(copies)
}
