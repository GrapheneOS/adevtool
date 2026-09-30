import { Command, Flags } from '@oclif/core'
import { promises as fs } from 'fs'
import path from 'path'

import os from 'os'
import { createVendorDirs, writeVersionCheckFile } from '../blobs/build'
import { findOverrideModules } from '../build/overrides'
import { minimizeModules, parseModuleInfo, TargetModuleInfo } from '../build/soong-info'
import {
  DEVICE_CONFIGS_FLAG_WITH_BUILD_ID,
  DeviceConfig,
  getDeviceBuildId,
  loadDeviceConfigs,
  loadDeviceConfigs2,
} from '../config/device'
import { ADEVTOOL_DIR, COLLECTED_SYSTEM_STATE_DIR } from '../config/paths'
import { collectSystemState, parseAllimagesFileList, serializeSystemState } from '../config/system-state'
import { forEachDevice } from '../frontend/devices'
import {
  enumerateFilesForCollectState,
  generateBuildFiles,
  processProps,
  writeEnvsetupCommands,
} from '../frontend/generate'
import { DeviceImages, prepareFactoryImages } from '../frontend/source'
import { loadBuildIndex } from '../images/build-index'
import { assertDefined, mapGet } from '../util/data'
import { EntryFilterCmd, filterEntries } from '../util/exact-filter'
import { isDirectory, isFile, readFile } from '../util/fs'
import { askConfirm, log, logElapsedTime, markTime, pause, StatusLine } from '../util/log'
import { PathResolver, PathResolverContext } from '../util/partitions'
import { lastLine, spawnAsync2, SpawnCmd } from '../util/process'

export default class CollectState extends Command {
  static description = 'collect build system state for use with other commands'

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
    keepOutDirs: Flags.boolean({
      description: "don't remove build output dirs after completion",
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
          let pathResolver = new PathResolver(
            path.join(outRoot, 'target/product', config.device.name),
            PathResolverContext.BUILD_OUTPUT_DIR,
          )
          await this.collectState(config, pathResolver, outPath)
        },
        c => c.device.name,
      )
      return
    }

    let deviceImagesMap = await prepareFactoryImages(await loadBuildIndex(), configs)
    let prepModulePaths: Promise<string>[] = []
    for (let config of configs) {
      let deviceImages = mapGet(deviceImagesMap, getDeviceBuildId(config))
      prepModulePaths.push(generatePrep(config, deviceImages))
    }
    let prepModules = await Promise.all(prepModulePaths)

    let outRootPrefix = 'out_adevtool_prep_build_' + Date.now() + '_'

    let phase2Tasks: ((buildOutDir: string) => Promise<void>)[] = []
    let outDirs: string[] = []

    let phase1Worker = async (index: number) => {
      let outRoot = outRootPrefix + index
      outDirs.push(outRoot)
      for (;;) {
        let config = configs.shift()
        if (config === undefined) {
          break
        }
        let systemRoot = path.join(outRoot, 'target/product', config.device.name)
        let pathResolver = new PathResolver(systemRoot, PathResolverContext.BUILD_OUTPUT_DIR)
        using statusLine = new StatusLine('')

        await runStateCollectionBuild(['module-info', 'allimages-file-list'], outRoot, statusLine, config, '1')

        let moduleInfoPath = path.join(pathResolver.basePath, 'module-info.json')
        let fullModuleInfo = parseModuleInfo(await readFile(moduleInfoPath))
        let moduleInfo = minimizeModules(fullModuleInfo, pathResolver)

        let fileList = await parseAllimagesFileList(pathResolver)
        let deviceImages = mapGet(deviceImagesMap, getDeviceBuildId(config))

        let factoryImagePathResolver = new PathResolver(deviceImages.unpackedFactoryImageDir)
        let namedEntries = await enumerateFilesForCollectState(fileList, factoryImagePathResolver)

        for (;;) {
          let { modules } = findOverrideModules(Array.from(namedEntries.keys()), moduleInfo)
          if (modules.length === 0) {
            break
          }
          modules.sort()

          let updatedConfig = (await loadDeviceConfigs([config.device.name]))[0]

          let anyUnknown = false
          let cmd = {
            entries: modules,
            exclusions: new Set(updatedConfig.replacement_module_exclusions),
            inclusions: new Set(updatedConfig.replacement_module_inclusions),
            unknownEntriesMessagePrefix: 'included unknown replacement modules',
            unknownEntryDisplayMapper(module: string) {
              anyUnknown = true
              let baseModuleName: string
              if (module.endsWith(':64')) {
                baseModuleName = module.slice(0, -3)
              } else if (module.endsWith(':32')) {
                baseModuleName = module.slice(0, -3) + '_32'
              } else {
                baseModuleName = module
              }
              let info = mapGet(fullModuleInfo, baseModuleName) as TargetModuleInfo
              return `${module} # ${info.path} | ${info.installed}`
            },
            yamlPath: [''],
          } as EntryFilterCmd
          modules = filterEntries(cmd)

          if (anyUnknown) {
            statusLine.set(config.device.name + ': waiting for replacement_module_exclusions resolution')
            await pause(`replacement_modules.yml update is needed for ${config.device.name}`)
            continue
          }

          phase2Tasks.push(async (buildOutDir: string) => {
            let systemRoot = path.join(buildOutDir, 'target/product', config.device.name)
            let pathResolver = new PathResolver(systemRoot, PathResolverContext.BUILD_OUTPUT_DIR)

            if (modules.length > 0) {
              let deviceMk = path.join('vendor', config.device.vendor, config.device.name, config.device.name + '.mk')
              await fs.writeFile(
                deviceMk,
                (await readFile(deviceMk)) + '\n\nPRODUCT_PACKAGES += \\\n    ' + modules.join(' \\\n    '),
              )
            }
            let extraModulesPath = getExtraModulesPath(pathResolver)
            await fs.mkdir(path.dirname(extraModulesPath), { recursive: true })
            await fs.writeFile(extraModulesPath, modules.join('\n'))

            using statusLine = new StatusLine('')

            await runStateCollectionBuild(['adevtool-state-collection-inputs'], buildOutDir, statusLine, config, '2')

            await this.collectState(config, pathResolver, outPath)

            if (disallowOutReuse) {
              statusLine.set(assertDefined(config).device.name + ': clearing out dir')
              await fs.rm(outRoot, { recursive: true })
            }
          })

          break
        }

        if (disallowOutReuse) {
          await fs.rm(outRoot, { recursive: true })
        }
      }
    }

    let phase2Worker = async (index: number) => {
      let outRoot = outRootPrefix + index
      outDirs.push(outRoot)
      for (;;) {
        let task = phase2Tasks.shift()
        if (task === undefined) {
          break
        }
        await task(outRoot)
      }
    }

    let freeMem = os.freemem() / (1 << 30)

    numWorkers = Math.min(numWorkers, configs.length)

    log(`Free memory: ${Math.floor(freeMem)} GiB, worker count: ${numWorkers}`)
    if (numWorkers === 1 && configs.length > 1) {
      log(`To increase the number of workers, use --numWorkers option.`)
    }

    let phase1Workers: Promise<void>[] = []
    for (let i = 0; i < numWorkers; i++) {
      phase1Workers.push(phase1Worker(i))
    }

    try {
      await Promise.all(phase1Workers)

      if (disallowOutReuse) {
        log('clearing phase 1 build output dirs')
        await Promise.all(outDirs.map(outDir => fs.rm(outDir, { recursive: true, force: true })))
      }

      // phase 2 can't run concurrently with phase 1 due to the build system requirement that all
      // build files should remain the same for the whole duration of the build

      let phase2Workers: Promise<void>[] = []
      for (let i = 0; i < numWorkers; i++) {
        phase2Workers.push(phase2Worker(i))
      }

      await Promise.all(phase2Workers)
    } finally {
      if (!flags.keepOutDirs) {
        log('clearing build output dirs')
        await Promise.all(outDirs.map(outDir => fs.rm(outDir, { recursive: true, force: true })))
      }
      await Promise.all(prepModules.map(dir => fs.rm(dir, { recursive: true })))
    }
  }

  async collectState(config: DeviceConfig, pathResolver: PathResolver, outPath: string) {
    let state = await collectSystemState(config.device.name, pathResolver)
    state.extraModules = (await readFile(getExtraModulesPath(pathResolver))).split('\n')

    let stateFilePath = (await isDirectory(outPath)) ? `${outPath}/${config.device.name}.json` : outPath
    await fs.writeFile(stateFilePath, serializeSystemState(state))
    log(`written serialized build state to ${stateFilePath}`)
  }
}

function getExtraModulesPath(pathResolver: PathResolver) {
  return path.join(pathResolver.basePath, 'extra-modules.txt')
}

async function generatePrep(config: DeviceConfig, deviceImages: DeviceImages) {
  let pathResolver = new PathResolver(deviceImages.unpackedFactoryImageDir)

  let dirs = await createVendorDirs(config.device.vendor, config.device.name)

  let propResults = await processProps(config, null, pathResolver, true)
  delete propResults.missingProps

  await generateBuildFiles(config, dirs, [], [], propResults, [], null, null, null, pathResolver, null)

  await writeEnvsetupCommands(config, dirs)
  await writeVersionCheckFile(config, dirs)

  log('generated prep vendor module at ' + dirs.out)
  return dirs.out
}

async function runStateCollectionBuild(
  targets: string[],
  outRoot: string,
  statusLine: StatusLine,
  deviceConfig: DeviceConfig,
  phase: string,
) {
  let device = deviceConfig.device.name
  let statusPrefix = `${device} phase ${phase}: `
  let cmd = {
    command: path.join(ADEVTOOL_DIR, 'scripts/make-state-collection-build.sh'),
    args: [device, outRoot, ...targets],
    handleStdoutBuffer(buf: Buffer) {
      let status = lastLine(buf)
      if (status.startsWith('[')) {
        statusLine.set(statusPrefix + status)
      }
    },
    isStderrLineAllowed(line: string) {
      return line.endsWith('setpriority(5): Permission denied')
    },
  } as SpawnCmd

  for (;;) {
    let buildStart = markTime()
    statusLine.set(statusPrefix + 'starting build')
    try {
      await spawnAsync2(cmd)
      logElapsedTime(buildStart, `${device} phase ${phase} state collection build took`)
      break
    } catch (e) {
      logElapsedTime(buildStart, `${device} phase ${phase} state collection build failed in`)
      let stderr = (e as Error).message as string
      if (stderr !== undefined) {
        log(`\n${statusPrefix}stderr:\n` + stderr)
      }
      let errorLog = path.join(outRoot, 'error.log')
      if (await isFile(errorLog)) {
        log(`\n${statusPrefix}${errorLog} :\n` + (await readFile(errorLog)))
      } else {
        let buildError = path.join(outRoot, 'build_error')
        if (await isFile(buildError)) {
          log(`\n${statusPrefix} ${buildError} :\n` + (await readFile(buildError)))
        }
      }
      log('\n')
      statusLine.set(statusPrefix + ' awaiting build restart confirmation')
      if (!(await askConfirm(`${statusPrefix}: try again?`))) {
        break
      }
    }
  }
}
