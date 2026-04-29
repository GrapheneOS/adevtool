import { Command, Flags } from '@oclif/core'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { GservicesCheckinRequestVariant, GservicesFlagsOutputGroup } from '../blobs/checkin'
import {
  decodeCheckinBinaryToTextproto,
  generateGservicesCheckinRequestVariants,
  getDefaultGservicesBuildId,
  randomHexSerial,
  updateGservicesFlagsFromRequestVariants,
} from '../blobs/checkin'
import type { DeviceBuildId, DeviceConfig } from '../config/device'
import { DEVICE_CONFIGS_FLAG_WITH_BUILD_ID, getDeviceBuildId, loadDeviceConfigs2 } from '../config/device'
import { ADEVTOOL_DIR, getHostBinPath } from '../config/paths'
import { forEachDevice } from '../frontend/devices'
import type { DeviceImages } from '../frontend/source'
import { deleteUnpackedDeviceImages, prepareFactoryImages } from '../frontend/source'
import { loadBuildIndex } from '../images/build-index'
import { TMP_PREFIX } from '../util/fs'
import { spawnAsync2 } from '../util/process'

export default class UpdateGservicesFlags extends Command {
  static description =
    'Synthesize a Checkin request from the device config, POST it to the live Google endpoint, and write filtered Gservices flags to vendor/adevtool/gservices-flags.'

  static flags = {
    ...DEVICE_CONFIGS_FLAG_WITH_BUILD_ID,
    serial: Flags.string({
      description: 'CheckinRequest.serial',
    }),
    randomSerial: Flags.boolean({
      description:
        'set CheckinRequest.serial to a fresh 16-char uppercase-hex random string. Mutually exclusive with --serial.',
      default: false,
    }),
    timezoneId: Flags.string({
      description: 'override CheckinRequest.timezone_id (default: America/New_York)',
    }),
    locale: Flags.string({
      description: 'override CheckinRequest.locale (default: en-US)',
    }),
    textprotoFile: Flags.file({
      description:
        'send this textproto file as the CheckinRequest body instead of generating one from the device config. ' +
        'This will use aprotoc instead of ts-proto. Use -d so the response is keyed per device.',
    }),
    saveRequestTextprotoDir: Flags.directory({
      description: 'write synthesized request textprotos under this directory, keyed by device and SKU.',
    }),
    fullResponse: Flags.boolean({
      description: 'print the full CheckinResponse textproto on stdout instead of the filtered gservices entries.',
      default: false,
    }),
    dryRun: Flags.boolean({
      description:
        'do not POST to the checkin endpoint; just print the request textproto on stdout ' +
        '(and write it to --saveRequestTextprotoDir if set).',
      default: false,
    }),
    debug: Flags.boolean({
      description: 'write raw request and response protobuf bodies to a temporary adevtool-* directory',
      default: false,
    }),
    parallel: Flags.boolean({
      char: 'p',
      description: 'generate devices in parallel',
      default: true,
      allowNo: true,
    }),
    devicesToKeepUnpacked: Flags.string({
      char: 'k',
      description:
        'Device or DeviceList config paths or names of unpacked images to keep. ' +
        'If this is set, other devices will have their unpacked images removed after successful Gservices flag generation.',
      multiple: true,
      default: [],
    }),
  }

  async run() {
    let { flags } = await this.parse(UpdateGservicesFlags)

    if (flags.serial !== undefined && flags.randomSerial) {
      throw new Error('serial and random serial are mutually exclusive')
    }
    if (flags.dryRun && flags.fullResponse) {
      throw new Error('dry-run and full response are mutually exclusive (no response is fetched in dry-run mode)')
    }
    if (flags.textprotoFile !== undefined) {
      if (flags.devices.length !== 1 || flags.devices[0] === 'all') {
        throw new Error('--textprotoFile requires exactly one explicit -d device')
      }
      if (
        flags.serial !== undefined ||
        flags.randomSerial ||
        flags.timezoneId !== undefined ||
        flags.locale !== undefined
      ) {
        throw new Error('--serial/--randomSerial/--timezoneId/--locale do not apply to --textprotoFile')
      }
    }

    let devices = await loadDeviceConfigs2(flags)
    let devicesToKeepUnpacked =
      flags.devicesToKeepUnpacked.length > 0
        ? new Set(
            (await loadDeviceConfigs2({ devices: flags.devicesToKeepUnpacked })).map(config => config.device.name),
          )
        : undefined
    let tmpDir: string | undefined
    if (flags.debug) {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX))
      process.stderr.write(`debug tmpDir: ${tmpDir}\n`)
    }

    let buildIndex = flags.textprotoFile === undefined ? await loadBuildIndex() : undefined

    let multi = devices.length > 1
    let processDevice = async (device: DeviceConfig) => {
      let codename = device.device.name
      let images: Map<DeviceBuildId, DeviceImages> | undefined
      let variants: GservicesCheckinRequestVariant[]
      if (flags.textprotoFile === undefined) {
        if (buildIndex === undefined) {
          throw new Error('build index was not loaded')
        }
        let buildId = getGservicesBuildId(device, flags.buildId)
        // Pass an explicit build-id list so prepareFactoryImages doesn't
        // auto-expand to `[device.build_id, device.backport_build_id]` and
        // download unrelated backports. If Euicc APKs come from a configured
        // backport, synthesize checkin from that build by default because those
        // packages are the consumers of the generated Gservices flags.
        images = await prepareFactoryImages(buildIndex, [device], [buildId])
        let img = images?.get(getDeviceBuildId(device, buildId))
        if (img === undefined) {
          throw new Error(`${codename}: factory image for Gservices build ${buildId} was not prepared`)
        }
        let serial: string | undefined
        if (flags.serial !== undefined) {
          serial = flags.serial
        } else if (flags.randomSerial) {
          serial = randomHexSerial()
        }

        variants = await generateGservicesCheckinRequestVariants({
          imageRoot: img.unpackedFactoryImageDir,
          deviceConfig: device,
          serial,
          timezoneId: flags.timezoneId,
          locale: flags.locale,
          debugDir: tmpDir,
        })
      } else {
        variants = [await generateTextprotoRequestVariant(device, flags.textprotoFile, tmpDir)]
      }

      for (let variant of variants) {
        if (flags.saveRequestTextprotoDir !== undefined || flags.dryRun) {
          let requestTextproto = await decodeCheckinBinaryToTextproto(
            variant.requestBinary,
            'android.checkin.CheckinRequest',
          )
          if (flags.saveRequestTextprotoDir !== undefined) {
            let savePath = getRequestTextprotoPath(flags.saveRequestTextprotoDir, codename, variant.sku)
            await fs.mkdir(path.dirname(savePath), { recursive: true })
            await fs.writeFile(savePath, requestTextproto)
          }
          if (flags.dryRun) {
            if (multi || variants.length > 1) {
              process.stdout.write(`# ===== ${codename}${variant.sku === undefined ? '' : ` ${variant.sku}`} =====\n`)
            }
            process.stdout.write(requestTextproto)
            if (multi || variants.length > 1) {
              process.stdout.write('\n')
            }
            continue
          }
        }
      }

      if (flags.dryRun) {
        return
      }

      let result = await updateGservicesFlagsFromRequestVariants(device, variants, tmpDir)
      for (let outFile of result.outFiles) {
        process.stderr.write(`filtered gservices flags written to ${outFile}\n`)
      }

      for (let variant of result.variants) {
        if (flags.fullResponse && (multi || result.variants.length > 1)) {
          process.stdout.write(`# ===== ${codename}${variant.sku === undefined ? '' : ` ${variant.sku}`} =====\n`)
        }
        if (variant.responseBodyPath !== undefined) {
          process.stdout.write(
            `# raw response written to ${variant.responseBodyPath} (${variant.response.body.length} bytes)\n`,
          )
        }

        if (flags.fullResponse) {
          let responseTextproto = await decodeCheckinBinaryToTextproto(
            variant.response.body,
            'android.checkin.CheckinResponse',
          )
          process.stdout.write(responseTextproto)
        }

        if (flags.fullResponse && (multi || result.variants.length > 1)) {
          process.stdout.write('\n')
        }
      }

      if (!flags.fullResponse) {
        writeFilteredGservicesFlagsOutput(codename, multi, result.filteredFlagGroups)
      }

      await deleteGservicesFactoryImageIfNeeded(images, device, flags.buildId, devicesToKeepUnpacked)
    }
    await forEachDevice(devices, flags.parallel, processDevice, device => device.device.name)
  }
}

async function deleteGservicesFactoryImageIfNeeded(
  images: Map<DeviceBuildId, DeviceImages> | undefined,
  device: DeviceConfig,
  buildIdOverride: string | undefined,
  devicesToKeepUnpacked: Set<string> | undefined,
) {
  if (images === undefined || devicesToKeepUnpacked === undefined || devicesToKeepUnpacked.has(device.device.name)) {
    return
  }

  let deviceBuildId = getDeviceBuildId(device, getGservicesBuildId(device, buildIdOverride))
  let image = images.get(deviceBuildId)
  if (image !== undefined) {
    await deleteUnpackedDeviceImages(new Map([[deviceBuildId, image]]))
  }
}

function getGservicesBuildId(device: DeviceConfig, buildIdOverride: string | undefined) {
  return buildIdOverride ?? getDefaultGservicesBuildId(device)
}

async function generateTextprotoRequestVariant(
  deviceConfig: DeviceConfig,
  textprotoFile: string,
  debugDir: string | undefined,
): Promise<GservicesCheckinRequestVariant> {
  let textprotoBytes = await fs.readFile(textprotoFile)
  let aprotoc = await getHostBinPath('aprotoc')
  let protoPath = path.join(ADEVTOOL_DIR, 'assets', 'checkin.proto')
  let protoDir = path.dirname(protoPath)
  let requestBinary = await spawnAsync2({
    command: aprotoc,
    args: [`--proto_path=${protoDir}`, '--encode=android.checkin.CheckinRequest', protoPath],
    stdinData: textprotoBytes,
  })
  let label = 'textproto'
  let requestBodyPath: string | undefined
  if (debugDir !== undefined) {
    requestBodyPath = path.join(debugDir, `${deviceConfig.device.name}-${label}-checkin-request.body`)
    await fs.writeFile(requestBodyPath, requestBinary)
  }

  return {
    sku: undefined,
    label,
    request: undefined,
    requestBinary,
    requestBodyPath,
  }
}

function writeFilteredGservicesFlagsOutput(codename: string, multi: boolean, groups: GservicesFlagsOutputGroup[]) {
  for (let group of groups) {
    let hasSku = group.sku !== undefined
    if (multi || hasSku) {
      process.stdout.write(`# ===== ${codename}${hasSku ? ` ${group.sku}` : ''}`)
      if (group.sameSkus.length > 0) {
        process.stdout.write(` (same filtered flags for ${group.sameSkus.join(', ')})`)
      }
      process.stdout.write(' =====\n')
    }
    process.stdout.write(group.serialized)
    if (multi || hasSku) {
      process.stdout.write('\n')
    }
  }
}

function getRequestTextprotoPath(dir: string, codename: string, sku: string | undefined): string {
  if (sku === undefined) {
    return path.join(dir, `${codename}.textproto`)
  }
  return path.join(dir, codename, `${sku}.textproto`)
}
