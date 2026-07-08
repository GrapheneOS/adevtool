import { promises as fs } from 'fs'
import type { Dirent } from 'fs'
import path from 'path'

import type { SoongModule } from '../build/soong'
import { serializeBlueprint } from '../build/soong'
import type { DeviceConfig } from '../config/device'
import { GSERVICES_FLAGS_DIR } from '../config/paths'
import type { GservicesFlag } from '../gservices/flags'
import { parseGservicesFlags, serializeGservicesFlags } from '../gservices/flags'
import { isFile } from '../util/fs'

const FLAGS_FILE_NAME = 'flags.txt'
const OUTPUT_DIR_NAME = 'gservices-flags'
const INSTALL_SUB_DIR = 'gmscompat/gservices-flags'
const MODULE_NAME_PREFIX = 'adevtool_gservices_flags'

interface FlagSet {
  sku: string | undefined
  flags: GservicesFlag[]
}

export interface GservicesFlagsResult {
  soongNamespace: string | undefined
  packageNames: string[]
}

export async function generateGservicesFlags(
  config: DeviceConfig,
  vendorDir: string,
): Promise<GservicesFlagsResult> {
  let sourceDir = path.join(GSERVICES_FLAGS_DIR, config.device.vendor, config.device.name)
  return generateGservicesFlagsFromDir(sourceDir, vendorDir)
}

export async function generateGservicesFlagsFromDir(
  sourceDir: string,
  vendorDir: string,
): Promise<GservicesFlagsResult> {
  let outputDir = path.join(vendorDir, OUTPUT_DIR_NAME)
  await fs.rm(outputDir, { recursive: true, force: true })

  let flagSets = await loadFlagSets(sourceDir)
  if (flagSets.length === 0) {
    return { soongNamespace: undefined, packageNames: [] }
  }

  let outputFlagSets = getOutputFlagSets(flagSets)
  if (outputFlagSets.length === 0) {
    return { soongNamespace: undefined, packageNames: [] }
  }

  let modules: SoongModule[] = []
  for (let flagSet of outputFlagSets) {
    modules.push(await writeFlagSet(outputDir, flagSet))
  }
  await fs.writeFile(path.join(outputDir, 'Android.bp'), serializeBlueprint({ namespace: true, modules }))

  return {
    soongNamespace: outputDir,
    packageNames: modules.map(module => module.name!),
  }
}

async function loadFlagSets(sourceDir: string): Promise<FlagSet[]> {
  let commonFile = path.join(sourceDir, FLAGS_FILE_NAME)
  if (await isFile(commonFile)) {
    return [
      {
        sku: undefined,
        flags: await readFlags(commonFile),
      },
    ]
  }

  let entries: Dirent[]
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }

  let result: FlagSet[] = []
  for (let entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue
    }

    let flagsFile = path.join(sourceDir, entry.name, FLAGS_FILE_NAME)
    if (!(await isFile(flagsFile))) {
      continue
    }

    result.push({
      sku: entry.name,
      flags: await readFlags(flagsFile),
    })
  }
  return result
}

async function readFlags(file: string) {
  return parseGservicesFlags(await fs.readFile(file, { encoding: 'utf8' }))
}

function getOutputFlagSets(flagSets: FlagSet[]) {
  let serialized = flagSets.map(flagSet => ({
    ...flagSet,
    serialized: serializeGservicesFlags(flagSet.flags),
  }))

  if (serialized.every(flagSet => flagSet.serialized.length === 0)) {
    return []
  }

  if (
    serialized.length === 1 ||
    serialized.every(flagSet => flagSet.serialized === serialized[0].serialized)
  ) {
    return [
      {
        sku: undefined,
        flags: serialized[0].flags,
      },
    ]
  }

  return serialized.map(flagSet => ({
    sku: flagSet.sku,
    flags: flagSet.flags,
  }))
}

async function writeFlagSet(outputDir: string, flagSet: FlagSet): Promise<SoongModule> {
  let src = flagSet.sku === undefined ? FLAGS_FILE_NAME : path.posix.join(flagSet.sku, FLAGS_FILE_NAME)
  let outFile = path.join(outputDir, src)
  await fs.mkdir(path.dirname(outFile), { recursive: true })
  await fs.writeFile(outFile, serializeGservicesFlags(flagSet.flags))

  return {
    _type: 'prebuilt_etc',
    name:
      flagSet.sku === undefined
        ? MODULE_NAME_PREFIX
        : `${MODULE_NAME_PREFIX}_${sanitizeModuleNamePart(flagSet.sku)}`,
    src,
    filename_from_src: true,
    sub_dir:
      flagSet.sku === undefined ? INSTALL_SUB_DIR : path.posix.join(INSTALL_SUB_DIR, flagSet.sku),
    system_ext_specific: true,
  }
}

function sanitizeModuleNamePart(value: string) {
  return value.replaceAll(/[^A-Za-z0-9_.-]/g, '_')
}
