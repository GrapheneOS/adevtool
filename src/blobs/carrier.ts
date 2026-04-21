import chalk from 'chalk'
import fetch from 'node-fetch'
import os from 'os'
import path from 'path'

import assert from 'assert'
import { createWriteStream, promises as fs } from 'fs'
import { parseInt } from 'lodash'
import { SmartBuffer } from 'smart-buffer'
import { promises as stream } from 'stream'
import { DeviceConfig } from '../config/device'
import { CARRIER_SETTINGS_DIR, getHostBinPath, OS_CHECKOUT_DIR } from '../config/paths'
import { CARRIER_SETTINGS_PATCHES } from './carrier-db-overrides'
import { CarrierList } from '../proto-ts/packages/apps/CarrierConfig2/src/com/google/carrier/carrier_list'
import {
  CarrierSettings,
  MultiCarrierSettings,
} from '../proto-ts/packages/apps/CarrierConfig2/src/com/google/carrier/carrier_settings'
import { Request } from '../proto-ts/vendor/adevtool/assets/request'
import { Response } from '../proto-ts/vendor/adevtool/assets/response'
import { exists, listFilesRecursive, TMP_PREFIX } from '../util/fs'
import { log } from '../util/log'
import { spawnAsync2, SpawnCmd } from '../util/process'

const PROTO_PATH = `${OS_CHECKOUT_DIR}/packages/apps/CarrierConfig2/src/com/google/carrier`

export async function fetchUpdateConfig(
  device: string,
  build_id: string,
  sdkVersion: string,
  debug: boolean,
): Promise<Map<string, string>> {
  const requestData: Request = {
    field1: {
      info: {
        int: 4,
        deviceInfo: {
          apilevel: parseInt(sdkVersion),
          name: device,
          buildId: build_id,
          name1: device,
          name2: device,
          locale1: 'en',
          locale2: 'US',
          manufacturer1: 'Google',
          manufacturer2: 'google',
          name3: device,
        },
      },
    },
    field2: {
      info: {
        pkgname: 'com.google.android.carrier',
      },
    },
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX))
  if (debug) {
    log(`tmpDir: ${tmpDir}`)
    const outFile = path.join(tmpDir, 'requestData')
    log(`requestData: ${outFile}`)
    await fs.writeFile(outFile, JSON.stringify(Request.toJSON(requestData), null, 4))
  }
  const encodedRequest = Request.encode(requestData).finish()
  if (debug) {
    const reqFile = path.join(tmpDir, 'encodedRequestData')
    await fs.writeFile(reqFile, encodedRequest)
    log(`encodedRequestData: ${reqFile}`)
  }
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-protobuf',
    },
    body: encodedRequest,
  }
  const response = await fetch(
    'https://www.googleapis.com/experimentsandconfigs/v1/getExperimentsAndConfigs?r=6&c=1',
    options,
  )
  assert(response.ok)
  const pbResponse = Buffer.from(await response.arrayBuffer())
  if (debug) {
    const tmpOutFile = path.join(tmpDir, 'encodedResponse')
    log(`encodedResponse: ${tmpOutFile}`)
    await fs.writeFile(tmpOutFile, pbResponse)
  }
  let result = new Map<string, string>()
  const decodedResponse = Response.decode(pbResponse).field1!.settings!.cfg!
  decodedResponse.forEach(cfg => {
    if (cfg.name === 'CarrierSettings__update_config') {
      const updateConfig = cfg!.unk1!.n!.entry!
      Object.keys(updateConfig).forEach(key => {
        result.set(key, updateConfig[key])
      })
    }
  })
  return result
}

export async function downloadAllConfigs(config: Map<string, string>, outDir: string, debug: boolean) {
  if (config.get('is_pixel') === 'no_ota' || config.size <= 2) {
    log(chalk.grey(`No updates are available for ${path.parse(outDir).base}`))
    return
  }
  await fs.rm(outDir, { force: true, recursive: true })
  for (let [entry, version] of config) {
    if (entry === 'carrier_list_url' || entry === 'carrier_settings_url') {
      continue
    }
    let url: string
    if (entry === 'carrier_list') {
      let baseUrl = config.get('carrier_list_url')!
      url = baseUrl.replace(/%d/g, version)
    } else {
      let baseUrl = config.get('carrier_settings_url')!
      url = baseUrl.replace(/%2\$s/i, entry).replace(/%3\$d/i, version)
    }
    if (debug) log(url)
    assert(url.includes('pixel'), `invalid url: ${url}`)

    let tmpOutFile = path.join(outDir, `${entry}.pb.tmp`)
    let outFile = path.join(outDir, `${entry}.pb`)
    await fs.mkdir(outDir, { recursive: true })
    await fs.rm(tmpOutFile, { force: true })
    let resp = await fetch(url)
    if (resp.ok) {
      await stream.pipeline(resp.body!, createWriteStream(tmpOutFile))
      await fs.rename(tmpOutFile, outFile)
      log(`Downloaded ${entry}-${version} to ${path.relative(OS_CHECKOUT_DIR, outFile)}`)
    } else {
      log(chalk.red(`Failed to download ${entry}-${version}\nurl: ${url}`))
    }
  }
}

export async function decodeCarrierConfigs(cfgPath: string, outDir: string) {
  let aprotocProcesses: Promise<void>[] = []
  if (await exists(cfgPath)) {
    await fs.mkdir(outDir, { recursive: true })
    let aprotocCmd = SmartBuffer.fromSize(10_000, 'utf-8')
    let numMessages = 0
    aprotocCmd.writeUInt32LE(0)
    for await (let filePath of listFilesRecursive(cfgPath)) {
      if (path.extname(filePath) !== '.pb') {
        continue
      }
      assert(filePath.endsWith('.pb'), filePath)
      let baseName = path.basename(filePath, '.pb')
      let outPath = path.join(outDir, baseName + '.textproto')

      switch (baseName) {
        case 'others':
          aprotocProcesses.push(
            decodeConfig(
              [
                '--proto_path',
                PROTO_PATH,
                '--decode',
                'com.google.carrier.MultiCarrierSettings',
                path.join(PROTO_PATH, 'carrier_settings.proto'),
              ],
              filePath,
              outPath,
            ),
          )
          break
        case 'carrier_list':
          aprotocProcesses.push(
            decodeConfig(
              [
                '--proto_path',
                PROTO_PATH,
                '--decode',
                'com.google.carrier.CarrierList',
                path.join(PROTO_PATH, 'carrier_list.proto'),
              ],
              filePath,
              outPath,
            ),
          )
          break
        default:
          numMessages += 1
          aprotocCmd.writeUInt32LE(filePath.length)
          aprotocCmd.writeString(filePath)
          aprotocCmd.writeUInt32LE(outPath.length)
          aprotocCmd.writeString(outPath)
          break
      }
      assert(numMessages > 0)
      aprotocCmd.writeUInt32LE(numMessages, 0)
    }

    // decoding hundreds of protobufs one by one is very slow, even when it's parallelized
    let out = await spawnAsync2({
      command: await getHostBinPath('aprotoc'),
      args: [
        '--proto_path',
        PROTO_PATH,
        '--bulk',
        '--decode',
        'com.google.carrier.CarrierSettings',
        path.join(PROTO_PATH, 'carrier_settings.proto'),
      ],
      stdinData: aprotocCmd.toBuffer(),
    })
    assert(out.length === 0, out.toString())
  }
  await Promise.all(aprotocProcesses)
}

async function decodeConfig(args: ReadonlyArray<string>, inputFile: string, outputFile: string) {
  let cmd = {
    command: await getHostBinPath('aprotoc'),
    args,
    stdinFileSource: inputFile,
    stdoutFileSink: outputFile,
  } as SpawnCmd
  await spawnAsync2(cmd)
}

export async function getVersionsMap(dir: string): Promise<Map<string, number>> {
  assert(await exists(dir))
  let versions = new Map<string, number>()
  for await (let file of listFilesRecursive(dir)) {
    if (path.extname(file) !== '.pb') {
      continue
    }
    const filename = path.parse(file).name
    const data = await fs.readFile(file)
    let decoded: MultiCarrierSettings | CarrierSettings | CarrierList
    switch (filename) {
      case 'others':
        decoded = MultiCarrierSettings.decode(data)
        break
      case 'carrier_list':
        decoded = CarrierList.decode(data)
        break
      default:
        decoded = CarrierSettings.decode(data)
    }
    const version = Number(decoded.version)
    versions.set(filename, version)
  }
  return versions
}

export function getCarrierSettingsUpdatesDir(config: DeviceConfig) {
  return path.join(CARRIER_SETTINGS_DIR, config.device.vendor, config.device.name)
}

export async function patchCarrierSettings(csDir: string) {
  for (const [carrierName, patches] of Object.entries(CARRIER_SETTINGS_PATCHES)) {
    const pbFile = path.join(csDir, `${carrierName}.pb`)
    if (!(await exists(pbFile))) {
      continue
    }
    const data = await fs.readFile(pbFile)
    const settings = CarrierSettings.decode(data)
    if (!settings.configs) {
      settings.configs = { config: [] }
    }
    for (const entry of patches) {
      const i = settings.configs.config.findIndex(c => c.key === entry.key)
      if (i >= 0) {
        settings.configs.config[i] = entry
      } else {
        settings.configs.config.push(entry)
      }
    }
    const encoded = CarrierSettings.encode(settings).finish()
    await fs.chmod(pbFile, 0o644)
    await fs.writeFile(pbFile, encoded)
    log(`Patched carrier settings: ${carrierName}`)
  }
}
