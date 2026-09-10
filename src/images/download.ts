import assert from 'assert'
import chalk from 'chalk'
import { createWriteStream, promises as fs } from 'fs'
import fetch from 'node-fetch'
import path from 'path'
import { IMAGE_DOWNLOAD_DIR } from '../config/paths'
import { log, StatusLine } from '../util/log'

import { Semaphore } from 'async-mutex'
import { pipeline } from 'stream/promises'
import { exists } from '../util/fs'
import { spawnAsync } from '../util/process'
import { ImageType } from './build-index'
import { DeviceImage } from './device-image'

export async function downloadDeviceImages(images: DeviceImage[], showTncNotice = true) {
  await fs.mkdir(IMAGE_DOWNLOAD_DIR, { recursive: true })
  if (showTncNotice) {
    logTermsAndConditionsNotice(images)
  }

  await Promise.all(
    images.map(image =>
      (async () => {
        using statusLine = new StatusLine('')
        await downloadImage(image, IMAGE_DOWNLOAD_DIR, statusLine)
      })(),
    ),
  )
}

export async function downloadDeviceImage(image: DeviceImage, statusLine: StatusLine): Promise<void> {
  await fs.mkdir(IMAGE_DOWNLOAD_DIR, { recursive: true })
  logTermsAndConditionsNotice([image])

  await downloadImage(image, IMAGE_DOWNLOAD_DIR, statusLine)
}

const downloadConcurrency = parseInt(process.env['ADEVTOOL_DOWNLOAD_CONCURRENCY'] ?? '20')
const downloadSemaphore = new Semaphore(downloadConcurrency)

async function downloadImage(image: DeviceImage, outDir: string, statusLine: StatusLine) {
  if (downloadSemaphore.isLocked()) {
    statusLine.set(`pending download (max concurrency is ${downloadConcurrency}): ${image.toString()}`)
  }
  let completeOutFile = path.join(outDir, image.fileName)
  let tmpOutFile = completeOutFile + '.tmp'

  await downloadSemaphore.runExclusive(async () => {
    await downloadImageInner(image, tmpOutFile, completeOutFile, statusLine)
  })
  statusLine.set(`checking SHA-256 for ${image.toString()}`)
  await checkImageDigest(image, tmpOutFile, completeOutFile)
}

async function downloadImageInner(
  image: DeviceImage,
  tmpOutFile: string,
  completeOutFile: string,
  statusLine: StatusLine,
) {
  assert(!(await exists(completeOutFile)), completeOutFile + ' already exists')

  let requestInit
  let resumedFrom = ''
  let isResuming = false
  try {
    let stat = await fs.stat(tmpOutFile)
    if (stat.size > 0) {
      isResuming = true
      resumedFrom = ` (resumed from ${(stat.size / 1e6).toFixed()} MB)`
      requestInit = {
        headers: {
          'Accept-Encoding': 'identity',
          Range: `bytes=${stat.size}-`,
        },
      }
    }
  } catch (_) {
    /* empty */
  }

  let resp = await fetch(image.url, requestInit)
  if (!resp.ok) {
    throw new Error(`${resp.status}: ${resp.statusText}; ${image.toString()} `)
  }
  if (resp.body === null) {
    throw new Error(`missing response body for ${image.toString()}`)
  }


  let downloaded = 0
  let totalSizeStr: string | null
  if (isResuming) {
    totalSizeStr = resp.headers.get('content-length')
  } else {
    totalSizeStr = resp.headers.get('x-identity-content-length')
    if (totalSizeStr === null) {
      totalSizeStr = resp.headers.get('content-length')
    }
  }
  if (totalSizeStr === null) {
    totalSizeStr = '0'
  }
  let totalSize = parseInt(totalSizeStr)

  let suffix = `downloading ${(totalSize / 1e6).toFixed()} MB ${image.toString()}${resumedFrom}`
  statusLine.set(' ... ' + suffix)

  resp.body.on('data', chunk => {
    downloaded += chunk.length
    let percent = Math.floor((downloaded / totalSize) * 100)
    let percentStr: string
    if (percent < 100) {
      if (percent < 10) {
        percentStr = '  ' + percent
      } else {
        percentStr = ' ' + percent
      }
    } else {
      percentStr = percent.toString()
    }
    statusLine.set(`${percentStr}% ${suffix}`)
  })

  await pipeline(resp.body, createWriteStream(tmpOutFile, { flags: 'a' /* append */ }))
}

async function checkImageDigest(image: DeviceImage, tmpOutFile: string, completeOutFile: string) {
  let sha256Digest = await spawnAsync('sha256sum', ['-b', tmpOutFile])
  assert(sha256Digest.endsWith('\n'))
  sha256Digest = sha256Digest.slice(0, -1)
  if (image.skipSha256Check) {
    log('skipping SHA-256 check for ' + completeOutFile + 'SHA-256: ' + sha256Digest)
  } else {
    assert(sha256Digest === image.sha256, `${image.toString()}: SHA-256 mismatch, expected ` + image.sha256)
  }

  await fs.rename(tmpOutFile, completeOutFile)
}

let shownTncNotice = false

function logTermsAndConditionsNotice(images: DeviceImage[]) {
  if (shownTncNotice) {
    return
  }

  if (
    images.filter(i => {
      return !i.isGrapheneOS && (i.type === ImageType.Factory || i.type === ImageType.Ota)
    }).length == 0
  ) {
    // vendor images show T&C notice themselves as part of unpacking
    return
  }

  log(chalk.bold("\nBy downloading images, you agree to Google's terms and conditions:"))

  let msg = '    - Factory images: https://developers.google.com/android/images#legal\n'
  if (images.find(i => i.type === ImageType.Ota) !== undefined) {
    msg += '    - OTA images: https://developers.google.com/android/ota#legal\n'
  }
  msg += '    - Beta factory/OTA images: https://developer.android.com/studio/terms\n'

  log(msg)

  shownTncNotice = true
}
