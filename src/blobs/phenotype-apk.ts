import { unzip } from 'unzipit'
import { getHostBinPath } from '../config/paths'
import { ApkBuildMetadata, AppRegistration, HeterodyneInfo } from '../proto-ts/vendor/adevtool/assets/heterodyne'
import { spawnAsync2 } from '../util/process'
import { NodeFileReader } from '../util/zip'

const BUILD_METADATA = 'com.google.android.build.data.properties'
const HETERODYNE_PREFIX = 'com.google.android.gms.phenotype.heterodyne_info.binarypb:'

interface ApkMetadata {
  packageName: string
  versionCode: string
  resourcePaths: Record<string, string>
}

export async function extractPhenotypeRegistration(apkPath: string, namespace: string): Promise<AppRegistration> {
  if (!namespace) {
    throw new Error('A Phenotype namespace is required')
  }
  // Check the exact name first, then the namespace before automatic package expansion.
  let metadataNamespaces = [...new Set([namespace, namespace.split('#')[0]])]
  let output = await spawnAsync2({
    command: await getHostBinPath('arsclib'),
    args: ['--metadata-json-stdin'],
    stdinData: Buffer.from(
      JSON.stringify({
        aapt2Path: await getHostBinPath('aapt2'),
        apkPath,
        metadataNames: [BUILD_METADATA, ...metadataNamespaces.map(name => HETERODYNE_PREFIX + name)],
      }),
    ),
  })
  let metadata: ApkMetadata = JSON.parse(output.toString())
  let reader = new NodeFileReader(apkPath)
  try {
    let { entries } = await unzip(reader)
    let values = new Map<string, Buffer>()
    for (let [name, file] of Object.entries(metadata.resourcePaths)) {
      let entry = entries[file]
      if (!entry || entry.isDirectory) {
        throw new Error(`${apkPath}: missing APK entry for ${name}: ${file}`)
      }
      values.set(name, Buffer.from(await entry.arrayBuffer()))
    }
    let buildData = values.get(BUILD_METADATA)
    let metadataNamespace = metadataNamespaces.find(name => values.has(HETERODYNE_PREFIX + name))
    return AppRegistration.fromPartial({
      configPackage: {
        name: namespace,
        version: metadata.versionCode,
        identity: { value: -1 },
        baselineCl: buildData === undefined ? undefined : readBaselineCl(buildData),
        variant: metadata.packageName,
      },
      heterodyneInfo:
        metadataNamespace === undefined
          ? undefined
          : readHeterodyneInfo(values.get(HETERODYNE_PREFIX + metadataNamespace)!, metadataNamespace),
    })
  } finally {
    await reader.close()
  }
}

function readBaselineCl(data: Buffer): string {
  let baseline = ApkBuildMetadata.decode(data).buildBaselineChangelist
  if (baseline === undefined || baseline.startsWith('-')) {
    throw new Error('Missing or negative baseline CL in build data')
  }
  return baseline
}

// GmsCore sends these message bytes in AppRegistration.heterodyne_info with field 1 removed.
function readHeterodyneInfo(data: Buffer, expectedNamespace: string): Buffer {
  let info = HeterodyneInfo.decode(data)
  if (info.namespace !== expectedNamespace) {
    throw new Error(`Expected heterodyne metadata for ${expectedNamespace}, received ${info.namespace}`)
  }
  info.namespace = undefined
  return Buffer.from(HeterodyneInfo.encode(info).finish())
}
