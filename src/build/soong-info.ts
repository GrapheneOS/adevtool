import assert from 'assert'

export interface BaseTargetModuleInfo {
  installed: Array<string>
  module_name?: string
}

export interface TargetModuleInfo extends BaseTargetModuleInfo {
  class?: Array<string>
  path: Array<string>
  tags?: Array<string>
  srcs: Array<string>
  module_name: string

  // Removed to reduce size in SystemState
  supported_variants?: Array<string>
  compatibility_suites?: Array<string>
  auto_test_config?: Array<string>
  test_config?: Array<string>
  dependencies?: Array<string>
  srcjars?: Array<string>
  classes_jar?: Array<string>
  test_mainline_modules?: Array<string>
  is_unit_test?: string
  shared_libs?: Array<string>
  static_libs?: Array<string>
  system_shared_libs?: Array<string>
  required?: Array<string>
  make_generated_module_info?: string
}

export type SoongModuleInfo = Map<string, BaseTargetModuleInfo>

const EXCLUDE_MODULE_CLASSES = new Set(['NATIVE_TESTS', 'FAKE', 'ROBOLECTRIC', 'STATIC_LIBRARIES'])

export function parseModuleInfo(info: string) {
  return new Map(Object.entries(JSON.parse(info))) as SoongModuleInfo
}

export function minimizeModules(info: SoongModuleInfo, systemRoot: string) {
  let res = new Map<string, BaseTargetModuleInfo>()
  for (let [key, module_] of info.entries()) {
    let m = module_ as TargetModuleInfo
    if (
      m.class!.every(cl => EXCLUDE_MODULE_CLASSES.has(cl)) ||
      !m.supported_variants!.includes('DEVICE') ||
      (m.tags?.length === 1 && m.tags[0] === 'tests') ||
      m.module_name.endsWith('RoboTests') ||
      m.module_name.endsWith('Ravenwood') ||
      m.installed === undefined ||
      (m.path.length === 1 && m.path![0].includes('/robotests'))
    ) {
      continue
    }

    let requiredPrefix = systemRoot + '/'

    let installed = []
    for (let p of m.installed) {
      if (!p.startsWith(requiredPrefix) || p.endsWith('.vdex') || p.endsWith('.odex')) {
        continue
      }
      let relPath = p.substring(requiredPrefix.length)
      if (!relPath.startsWith('data/')) {
        installed.push(relPath)
      }
    }

    if (installed.length === 0) {
      continue
    }

    let moduleNameProp: string | undefined = m.module_name
    if (key === moduleNameProp) {
      moduleNameProp = undefined
    } else {
      assert(key === moduleNameProp + '_32', key)
    }

    let bm = {
      installed,
      module_name: moduleNameProp,
    } as BaseTargetModuleInfo

    res.set(key, bm)

    m.installed = installed
  }
  return res
}
