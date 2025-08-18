import { Command, Flags } from '@oclif/core'
import { promises as fs } from 'fs'
import path from 'path'
import asyncPool from 'tiny-async-pool'
import xml2js from 'xml2js'
import { DEVICE_CONFIGS_FLAG_WITH_BUILD_ID, loadDeviceConfigs } from '../config/device'
import { IMAGE_DOWNLOAD_DIR } from '../config/paths'
import { prepareFactoryImages } from '../frontend/source'
import { loadBuildIndex } from '../images/build-index'
import { exists, listFilesRecursive } from '../util/fs'
import { spawnAsync } from '../util/process'

export default class Decompile extends Command {
  static flags = {
    numWorkers: Flags.integer({
      description: 'max number of concurrent jadx decompilations',
      default: 8,
    }),
    ...DEVICE_CONFIGS_FLAG_WITH_BUILD_ID,
  }

  async run() {
    let { flags } = await this.parse(Decompile)

    let devices = await loadDeviceConfigs(flags.devices)
    let images = await prepareFactoryImages(await loadBuildIndex(), devices, flags.buildId != null ? [flags.buildId] : null)
    for (let img of images.values()) {
      let items: DecompiledItem[] = []
      let tasks: Promise<unknown>[] = []
      let outRoot = path.join(IMAGE_DOWNLOAD_DIR, 'decompiled', path.basename(img.unpackedFactoryImageDir))

      let ideaDir = path.join(outRoot, '.idea')
      let ideaModulesDir = path.join(ideaDir, 'modules')
      await Promise.all([fs.mkdir(outRoot, { recursive: true }), fs.mkdir(ideaModulesDir, { recursive: true })])

      let dirs = ['apex', 'app', 'framework', 'priv-app', 'lib']
      let relpaths = [
        'system/system',
        'system_ext',
        'product',
        'vendor',
        'unpacked_apexes/system/system',
        'unpacked_apexes/system_ext',
        'unpacked_apexes/vendor',
      ]

      for (let relpath of relpaths) {
        for (let dir of dirs) {
          let basePath = path.join(img.unpackedFactoryImageDir, relpath, dir)
          if (!(await exists(basePath))) {
            continue
          }
          direntLoop: for await (let dirent of listFilesRecursive(basePath)) {
            let isJar = dirent.endsWith('.jar')
            let isApk = dirent.endsWith('.apk')
            if (!isJar && !isApk) {
              continue
            }

            let relEntPath = path.relative(img.unpackedFactoryImageDir, dirent)
            if (relEntPath.startsWith('product/priv-app/PrebuiltGmsCore')) {
              continue
            }

            if (isApk) {
              let baseName = path.basename(dirent).slice(0, -4)
              // skip irrelevant large packages
              let prefixes = [
                'AICorePrebuilt',
                'arcore',
                'CalculatorGoogle',
                'DeviceIntelligenceNetworkPrebuilt',
                'DevicePersonalizationPrebuilt',
                'DevicePolicyPrebuilt',
                'Dreamliner',
                'GoogleRestorePrebuilt',
                'PixelThemesStub',
                'PixelWallpaper',
                'PrebuiltGmsCore',
                'RecorderPrebuilt',
                'ScribePrebuilt',
                'SoundAmplifierPrebuilt',
                'SystemUIClocks',
                'TipsPrebuilt',
                'WallpaperEmojiPrebuilt',
              ]
              switch (baseName) {
                case 'AccessibilityMenu':
                case 'AndroidAutoStubPrebuilt':
                case 'CalendarGooglePrebuilt':
                case 'Chrome':
                case 'Drive':
                case 'FilesPrebuilt':
                case 'GoogleCamera':
                case 'GoogleContacts':
                case 'GoogleDialer':
                case 'GoogleTTS':
                case 'LatinIMEGooglePrebuilt':
                case 'Maps':
                case 'MeetPrebuilt':
                case 'MyVerizonServices':
                case 'Phonesky': // Play Store
                case 'Photos':
                case 'PixelLiveWallpaperPrebuilt':
                case 'PixelSupportPrebuilt':
                case 'PrebuiltBugle': // Google Messages
                case 'PrebuiltGmail':
                case 'PrebuiltGmsCore':
                case 'SafetyHubPrebuilt':
                case 'SoundPickerPrebuilt':
                case 'SwitchAccessPrebuilt':
                case 'talkback':
                case 'TrichromeLibrary':
                case 'Tycho':
                case 'Velvet': // Google search app
                case 'Videos':
                case 'VoiceAccessPrebuilt':
                case 'WeatherPixelPrebuilt':
                case 'WebViewGoogle':
                case 'WellbeingPrebuilt':
                case 'YouTube':
                case 'YouTubeMusicPrebuilt':
                  continue
              }
              for (let prefix of prefixes) {
                if (baseName.startsWith(prefix)) {
                  continue direntLoop
                }
              }
            }

            let i = new DecompiledItem(img.unpackedFactoryImageDir, outRoot, relEntPath)
            items.push(i)
            let iml = createIml(i.name)
            tasks.push(fs.writeFile(path.join(ideaModulesDir, i.name + '.iml'), iml))
          }
        }
      }

      tasks.push(fs.writeFile(path.join(ideaDir, 'modules.xml'), createRoot(items.map(n => n.name))))
      tasks.push(fs.writeFile(path.join(ideaDir, 'misc.xml'), createMisc()))

      await Array.fromAsync(asyncPool(flags.numWorkers, items, i => jadx(i)))

      await Promise.all(tasks)
    }
  }
}

class DecompiledItem {
  readonly name: string
  readonly srcPath: string
  readonly dst: string

  constructor(
    unpackedRoot: string,
    outRoot: string,
    readonly relPath: string,
  ) {
    let prefix = 'system/system/'
    let name = relPath
    if (name.startsWith(prefix)) {
      name = name.substring('system/'.length)
    }

    let apkSuffix = '.apk'
    if (name.endsWith(apkSuffix)) {
      let components = name.split('/')
      let nc = components.length
      let parentName = components[nc - 2]
      if (parentName === components[nc - 1].slice(0, -apkSuffix.length)) {
        name = components.slice(0, -2).join('.')
        if (parentName.match('.+_[0-9].+')) {
          parentName = parentName.substring(0, parentName.lastIndexOf('_'))
        }
        name += `.${parentName}.apk`
      }
    }

    this.name = name.replaceAll('/', '.') + 'd'
    this.srcPath = path.join(unpackedRoot, relPath)
    this.dst = path.join(outRoot, this.name)
  }
}

async function jadx(i: DecompiledItem) {
  await spawnAsync(
    'jadx',
    [
      '--quiet',
      '--show-bad-code',
      '--no-imports',
      '--comments-level',
      'warn',
      '--threads-count',
      '1',
      '--output-dir',
      i.dst,
      i.srcPath,
    ],
    undefined,
    undefined,
    [0, 1],
  )
}

function makeBuilder() {
  return new xml2js.Builder({ headless: true })
}

const PREFIX = '<?xml version="1.0" encoding="UTF-8"?>\n'

function createRoot(moduleNames: string[]) {
  let modules: unknown = {}
  modules.module = moduleNames.map(n => {
    let filepath = `$PROJECT_DIR$/.idea/modules/${n}.iml`
    return {
      $: { fileurl: 'file://' + filepath, filepath },
    }
  })
  let proj: unknown = {
    $: { version: 4 },
    component: { $: { name: 'ProjectModuleManager' }, modules },
  }

  return PREFIX + makeBuilder().buildObject({ project: proj })
}

function createMisc() {
  let proj: unknown = {
    $: { version: 4 },
    component: {
      $: {
        name: 'ProjectRootManager',
        version: 2,
        languageLevel: 'JDK_16',
        'project-jdk-name': '17',
        'project-jdk-type': 'JavaSDK',
      },
    },
  }

  return PREFIX + makeBuilder().buildObject({ project: proj })
}

function createIml(name: string) {
  let component: unknown = {
    $: { name: 'NewModuleRootManager', LANGUAGE_LEVEL: 'JDK_17', 'inherit-compiler-output': 'true' },
  }
  component['exclude-output'] = {}
  component.content = {
    $: { url: `file://$MODULE_DIR$/../../${name}` },
    sourceFolder: { $: { url: `file://$MODULE_DIR$/../../${name}/sources`, isTestSource: false } },
  }

  let entries: unknown[] = [{ $: { type: 'sourceFolder', forTests: 'false' } }, { $: { type: 'inheritedJdk' } }]

  let baseFw = 'system.framework.framework.jard'
  if (baseFw !== name) {
    entries.push({ $: { type: 'module', 'module-name': 'system.framework.framework.jard' } })
  } else {
    entries.push({ $: { type: 'module', 'module-name': 'system.framework.framework-res.apkd' } })
  }

  component.orderEntry = entries

  let module: unknown = { $: { type: 'JAVA_MODULE', version: 4 }, component }
  return PREFIX + makeBuilder().buildObject({ module })
}
