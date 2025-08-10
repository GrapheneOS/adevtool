import { Command, Flags } from '@oclif/core'
import assert from 'assert'
import { promises as fs } from 'fs'
import path from 'path'

import os from 'os'
import { DEVICE_CONFIGS_FLAG_WITH_BUILD_ID, DeviceConfig, getDeviceBuildId, loadDeviceConfigs2 } from '../config/device'
import { ADEVTOOL_DIR, COLLECTED_SYSTEM_STATE_DIR } from '../config/paths'
import { collectSystemState, serializeSystemState } from '../config/system-state'
import { forEachDevice } from '../frontend/devices'
import { prepareFactoryImages } from '../frontend/source'
import { loadBuildIndex } from '../images/build-index'
import { isDirectory } from '../util/fs'
import { spawnAsync } from '../util/process'
import { generatePrep } from './generate-prep'

export default class CollectState extends Command {
  static description = 'collect built system state for use with other commands'

  static flags = {
    help: Flags.help({ char: 'h' }),
    outRoot: Flags.string({
      char: 'r',
      description:
        'path to state collection build output directory, should be relative to ANDROID_BUILD_TOP dir (e.g. out)',
    }),
    parallel: Flags.boolean({
      char: 'p',
      description: 'generate devices in parallel (causes buggy progress spinners)',
      default: false,
    }),
    outPath: Flags.string({
      char: 'o',
      description: `output path for system state JSON file(s). If it's a directory, $device.json will be used for file names`,
      required: true,
      default: COLLECTED_SYSTEM_STATE_DIR,
    }),
    immediate: Flags.boolean({
      description: 'collect state immediately, without generating a prep vendor module and invoking the build system',
      default: false,
    }),
    disallowOutReuse: Flags.boolean({
      description: 'remove outRoot dir before invoking the build system. Has no effect if --immediate is specified',
    }),
    numWorkers: Flags.integer({
      description: 'max number of concurrent state collection builds',
      default: 1,
    }),
    ...DEVICE_CONFIGS_FLAG_WITH_BUILD_ID,
  }

  async run() {
    let { flags } = await this.parse(CollectState)
    let { outRoot, parallel, outPath, immediate, disallowOutReuse, numWorkers } = flags

    let configs = await loadDeviceConfigs2(flags)

    if (immediate) {
      if (outRoot === undefined) {
        throw new Error('immediate state collection requires specifying the outRoot directory')
      }
      await forEachDevice(
        configs,
        parallel,
        async config => {
          await this.collectState(config, outRoot, outPath)
        },
        c => c.device.name,
      )
      return
    }

    let deviceImagesMap = await prepareFactoryImages(await loadBuildIndex(), configs)
    let prepModulePaths: Promise<string>[] = []
    for (let config of configs) {
      let deviceImages = deviceImagesMap.get(getDeviceBuildId(config))
      assert(deviceImages !== undefined)
      prepModulePaths.push(generatePrep(config, deviceImages.unpackedFactoryImageDir))
    }
    let prepModules = await Promise.all(prepModulePaths)

    let outRootPrefix = 'out_adevtool_prep_build_' + Date.now() + '_'

    let worker = async (index: number) => {
      let outRoot = outRootPrefix + index
      for (;;) {
        let config = configs.pop()
        if (config === undefined) {
          break
        }
        this.log('Starting build for ' + config.device.name)

        let label = `${config.device.name} state collection build took`
        console.time(label)
        await spawnAsync(path.join(ADEVTOOL_DIR, 'scripts/make-state-collection-build.sh'), [
          config.device.name,
          outRoot,
          'adevtool-state-collection-inputs',
        ])
        console.timeEnd(label)

        await this.collectState(config, outRoot, outPath)

        if (disallowOutReuse) {
          await fs.rm(outRoot, { recursive: true })
        }
      }
      await fs.rm(outRoot, { recursive: true })
    }

    let freeMem = os.freemem() / (1 << 30)

    this.log(`Free memory: ${Math.floor(freeMem)} GiB, worker count: ${numWorkers}`)
    if (numWorkers === 1) {
      this.log(`To increase the number of workers, use --numWorkers option.`)
    }

    let workers: Promise<void>[] = []
    for (let i = 0; i < numWorkers; i++) {
      workers.push(worker(i))
    }

    await Promise.all(workers)

    await Promise.all(prepModules.map(dir => fs.rm(dir, { recursive: true })))
  }

  async collectState(config: DeviceConfig, outRoot: string, outPath: string) {
    let systemRoot = `${outRoot}/target/product/${config.device.name}`

    let state = await collectSystemState(config.device.name, systemRoot)

    let stateFilePath = (await isDirectory(outPath)) ? `${outPath}/${config.device.name}.json` : outPath
    await fs.writeFile(stateFilePath, serializeSystemState(state, systemRoot))
    this.log(`written serialized build state to ${stateFilePath}`)
  }
}
