import { Command, Flags } from '@oclif/core'
import assert from 'assert'
import * as fs from 'fs/promises'
import path from 'path'
import { DEVICE_CONFIGS_FLAG_WITH_BUILD_ID, getDeviceBuildId, loadDeviceConfigs2 } from '../config/device'
import { getUnpackedApexesDir, prepareFactoryImages } from '../frontend/source'
import { loadBuildIndex } from '../images/build-index'
import {
  flagMetadata_flagPurpose,
  flagMetadata_flagPurposeToJSON,
  flagPermissionToJSON,
  flagState,
  flagStateToJSON,
  parsedFlag,
  parsedFlags,
} from '../proto-ts/build/make/tools/aconfig/aconfig_protos/protos/aconfig'
import { assertDefined } from '../util/data'
import { exists, isDirectory, isFile } from '../util/fs'
import { partitionRelativePath, REGULAR_SYS_PARTITIONS } from '../util/partitions'

export default class ExtractAconfig extends Command {
  static flags = {
    outDir: Flags.file({
      char: 'o',
      required: true,
    }),
    ...DEVICE_CONFIGS_FLAG_WITH_BUILD_ID,
  }

  async run() {
    let { flags } = await this.parse(ExtractAconfig)
    let devices = await loadDeviceConfigs2(flags)
    assert(devices.length === 1)
    let res = await prepareFactoryImages(await loadBuildIndex(), devices)
    let images = assertDefined(res.get(getDeviceBuildId(devices[0])))

    const FLAGS_PROTO_REL_PATH = 'etc/aconfig_flags.pb'

    let buildId = images.factoryImage.buildId
    let flagSet = buildId.substring(0, buildId.indexOf('.')).toLowerCase()

    let baseDir = flags.outDir

    let jobs: Promise<unknown>[] = []

    let flagDecoder = new FlagDecoder(baseDir, flagSet)

    for (let partition of REGULAR_SYS_PARTITIONS) {
      let flagsPath = path.join(images.unpackedFactoryImageDir, partitionRelativePath(partition), FLAGS_PROTO_REL_PATH)
      let job = async () => {
        if (await isFile(flagsPath)) {
          await flagDecoder.decodeFile(flagsPath)
        }
      }
      jobs.push(job())

      let apexDir = path.join(getUnpackedApexesDir(images), partitionRelativePath(partition), 'apex')
      let apexJob = async () => {
        if (!(await isDirectory(apexDir))) {
          return
        }
        let subjobs: Promise<unknown>[] = []
        for (let dirent of await fs.readdir(apexDir)) {
          let maybeFlagsPath = path.join(apexDir, dirent, FLAGS_PROTO_REL_PATH)
          let subjob = async () => {
            if (await isFile(maybeFlagsPath)) {
              await flagDecoder.decodeFile(maybeFlagsPath)
            }
          }
          subjobs.push(subjob())
        }
        await Promise.all(subjobs)
      }
      jobs.push(apexJob())
    }

    await Promise.all(jobs)

    let values: string[] = []
    for (let p of flagDecoder.seenPackages.values()) {
      values.push(`"aconfig-values-${flagSet}-${p}-all"`)
    }

    values.sort()

    let rootAndroidBp = `aconfig_value_set {
    name: "aconfig_value_set-${flagSet}",
    values: [
      ${values.join(',\n      ')}
    ]
}
`
    await fs.writeFile(path.join(baseDir, 'Android.bp'), rootAndroidBp)
  }
}

class FlagDecoder {
  seenPackages = new Set<string>()
  constructor(
    readonly baseDir: string,
    readonly flagSet: string,
  ) {}

  async decodeFile(filePath: string) {
    let flags = parsedFlags.decode(new Uint8Array(await fs.readFile(filePath)))

    let promises = []

    for (let parsedFlag of flags.parsedFlag) {
      if (parsedFlag.state !== flagState.ENABLED) {
        continue
      }
      let flagPackage = parsedFlag.package!
      let dstPath = path.join(this.baseDir, flagPackage)
      promises.push(this.convertFlag(parsedFlag, dstPath))
    }

    await Promise.all(promises)
  }

  async convertFlag(flag: parsedFlag, dstPath: string) {
    let comments: string[] = []

    if (flag.container !== undefined) {
      comments.push(`container: ${flag.container}`)
    }

    if (flag.namespace !== undefined) {
      comments.push('namespace: ' + flag.namespace)
    }

    if (
      flag.metadata?.purpose !== undefined &&
      flag.metadata.purpose !== flagMetadata_flagPurpose.PURPOSE_UNSPECIFIED
    ) {
      comments.push('purpose: ' + flagMetadata_flagPurposeToJSON(flag.metadata.purpose))
    }

    if (flag.bug !== undefined) {
      comments.push(`bug: ${flag.bug}`)
    }

    if (flag.description !== undefined) {
      comments.push(`description: ${flag.description}`)
    }

    for (let t of flag.trace) {
      comments.push(`trace: ${t.source} : ${flagStateToJSON(t.state!)}`)
    }

    let flagPackage = flag.package!
    if (!(await exists(dstPath))) {
      await fs.mkdir(dstPath, { recursive: true })
    }

    if (!this.seenPackages.has(flagPackage)) {
      this.seenPackages.add(flagPackage)

      let androidBp = `aconfig_values {
  name: "aconfig-values-${this.flagSet}-${flagPackage}-all",
  package: "${flagPackage}",
  srcs: [
    "*_flag_values.textproto",
  ]
}
`
      await fs.writeFile(path.join(dstPath, 'Android.bp'), androidBp)
    }

    let flagName = flag.name!

    let contents = `flag_value {
  package: "${flagPackage}"
  name: "${flagName}"
  state: ${flagStateToJSON(flag.state!)}
  permission: ${flagPermissionToJSON(flag.permission!)}
`

    for (let comment of comments) {
      contents += '  # ' + comment + '\n'
    }

    contents += '}\n'

    let flagFileName = `${flagName}_flag_values.textproto`
    await fs.writeFile(path.join(dstPath, flagFileName), contents)
  }
}
