import fetch from 'node-fetch'
import path from 'path'
import { getDeviceBuildId, loadDeviceConfigs, resolveBuildId } from '../config/device'
import { ADEVTOOL_DIR, getHostBinPath } from '../config/paths'
import { prepareFactoryImages } from '../frontend/source'
import { loadBuildIndex } from '../images/build-index'
import {
  AppRegistration,
  ClientInfo_ClientType,
  ConfigPackageRef,
  FetchReason,
  Flag,
  FlagType,
  GetExperimentsAndConfigsRequest,
  GetExperimentsAndConfigsResponse,
} from '../proto-ts/vendor/adevtool/assets/heterodyne'
import { PathResolver } from '../util/partitions'
import { spawnAsync2 } from '../util/process'
import {
  BOOT_HARDWARE_PROP,
  BUILD_ID_PROP,
  BUILD_VERSION_SDK_PROP,
  deriveBuildFingerprint,
  getProp,
  HARDWARE_PROP,
  loadPartitionProps,
  PartitionProps,
  synthRoProduct,
} from './props'

const PROTO_PATH = path.join(ADEVTOOL_DIR, 'assets', 'heterodyne.proto')
const FETCH_REASON = FetchReason.NEW_APPLICATION
const CLIENT_TYPE = 1 // GMSCORE_PHENOTYPE, separate from ClientInfo.ClientType.
const URL = 'https://www.googleapis.com/experimentsandconfigs/v1/getExperimentsAndConfigs'
const GMS_VERSION_CODE = 263436035
const CRONET_VERSION = '151.0.7922.83'

interface PhenotypeLocale {
  language?: string
  country?: string
}

export async function phenotypeTextproto(
  mode: 'encode' | 'decode',
  message: 'AppRegistration' | 'Flag' | 'GetExperimentsAndConfigsRequest' | 'GetExperimentsAndConfigsResponse',
  input: Buffer,
) {
  return spawnAsync2({
    command: await getHostBinPath('aprotoc'),
    args: [`--proto_path=${path.dirname(PROTO_PATH)}`, `--${mode}=heterodyne.${message}`, PROTO_PATH],
    stdinData: input,
  })
}

export async function parsePhenotypeApp(textproto: Buffer, configPackageName?: string): Promise<AppRegistration> {
  let binary = await phenotypeTextproto('encode', 'AppRegistration', textproto)
  let app = AppRegistration.decode(binary)
  if (configPackageName !== undefined) {
    app.configPackage ??= ConfigPackageRef.fromPartial({})
    app.configPackage.name = configPackageName
  }
  if (!app.configPackage?.name?.trim()) {
    throw new Error('AppRegistration textproto requires config_package.name')
  }
  return app
}

export function buildPhenotypeClientProperties(props: PartitionProps, codename: string, locale: PhenotypeLocale = {}) {
  let sdkVersion = Number(getProp(props, BUILD_VERSION_SDK_PROP))
  let fingerprint = deriveBuildFingerprint(props)
  let buildId = getProp(props, BUILD_ID_PROP)
  if (!Number.isSafeInteger(sdkVersion) || sdkVersion <= 0 || !fingerprint || !buildId) {
    throw new Error(`${codename}: missing or invalid SDK version, build ID or fingerprint in factory image`)
  }
  return {
    clientInfo: {
      clientType: ClientInfo_ClientType.ANDROID,
      androidClientInfo: {
        sdkVersion,
        model: synthRoProduct(props, 'model'),
        product: synthRoProduct(props, 'name') ?? codename,
        osBuild: buildId,
        hardware: getProp(props, HARDWARE_PROP) ?? getProp(props, BOOT_HARDWARE_PROP) ?? codename,
        device: synthRoProduct(props, 'device') ?? codename,
        locale: locale.language ?? 'en',
        country: locale.country ?? 'US',
        manufacturer: synthRoProduct(props, 'manufacturer'),
        brand: synthRoProduct(props, 'brand'),
        board: getProp(props, 'ro.product.board'),
        fingerprint,
      },
    },
  }
}

export function buildPhenotypeRequest(
  props: PartitionProps,
  codename: string,
  app: AppRegistration,
  locale: PhenotypeLocale = {},
) {
  let request = GetExperimentsAndConfigsRequest.fromPartial({
    clientProperties: buildPhenotypeClientProperties(props, codename, locale),
    app: [app],
    fetchReason: FETCH_REASON,
    clientType: CLIENT_TYPE,
    triggeringPackage: app.configPackage?.variant,
  })
  return Buffer.from(GetExperimentsAndConfigsRequest.encode(request).finish())
}

export async function preparePhenotypeRequest(
  deviceName: string,
  build: string | undefined,
  app: AppRegistration,
  locale: PhenotypeLocale = {},
) {
  let devices = await loadDeviceConfigs([deviceName])
  if (devices.length !== 1) {
    throw new Error('-d must select exactly one device')
  }
  let device = devices[0]
  let buildId = resolveBuildId(build ?? device.device.build_id, device)
  let images = await prepareFactoryImages(await loadBuildIndex(), [device], [buildId])
  let image = images.get(getDeviceBuildId(device, buildId))
  if (image === undefined) {
    throw new Error(`${device.device.name}: factory image for ${buildId} was not prepared`)
  }
  let props = await loadPartitionProps(new PathResolver(image.unpackedFactoryImageDir))
  return { device, request: buildPhenotypeRequest(props, device.device.name, app, locale) }
}

export async function fetchPhenotypeFlags(request: Buffer): Promise<Buffer> {
  let build = GetExperimentsAndConfigsRequest.decode(request).clientProperties?.clientInfo?.androidClientInfo
  let release = build?.fingerprint?.match(/^[^/]+\/[^/]+\/[^:]+:([^/]+)\//)?.[1] ?? ''
  let locale = [build?.locale, build?.country].filter(Boolean).join('_')
  let userAgent = `com.google.android.gms/${GMS_VERSION_CODE} (Linux; U; Android ${release}; ${locale}`
  if (build?.model) {
    userAgent += `; ${build.model}`
  }
  if (build?.osBuild) {
    userAgent += `; Build/${build.osBuild}`
  }
  userAgent += `; Cronet/${CRONET_VERSION})`
  let response = await fetch(`${URL}?r=${FETCH_REASON}&c=${CLIENT_TYPE}`, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
    headers: {
      'Content-Type': 'application/x-protobuf',
      'User-Agent': userAgent,
    },
    body: request,
  })
  let body = Buffer.from(await response.arrayBuffer())
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from Phenotype: ${response.statusText}\n${body.subarray(0, 512)}`)
  }
  return body
}

export function getPhenotypeFlag(response: Buffer, packageName: string, flagName: string): Flag {
  let decoded = GetExperimentsAndConfigsResponse.decode(response)
  let matches = decoded.packageResult
    .filter(pkg => pkg.packageRef?.name === packageName)
    .flatMap(pkg => pkg.flagSet)
    .flatMap(set => set.flag)
    .filter(flag => flag.name === flagName)
  if (matches.length !== 1) {
    throw new Error(`${packageName}: expected one value for flag ${flagName}, received ${matches.length}`)
  }
  return matches[0]
}

export function getPhenotypeBytesFlag(response: Buffer, packageName: string, flagName: string): Buffer {
  let flag = getPhenotypeFlag(response, packageName, flagName)
  if (flag.type !== FlagType.BYTES || flag.bytesValue?.value === undefined) {
    throw new Error(`${packageName}: flag ${flagName} is not a bytes value`)
  }
  return Buffer.from(flag.bytesValue.value)
}
