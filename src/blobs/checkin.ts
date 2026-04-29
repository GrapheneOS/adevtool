import crypto from 'crypto'
import { XMLParser } from 'fast-xml-parser'
import { Dirent, promises as fs } from 'fs'
import hasha from 'hasha'
import fetch from 'node-fetch'
import path from 'path'
import yauzl from 'yauzl-promise'
import * as zlib from 'zlib'
import { DeviceConfig, DisplaySize } from '../config/device'
import { filterValue } from '../config/filters'
import { ADEVTOOL_DIR, getHostBinPath, GSERVICES_FLAGS_DIR } from '../config/paths'
import { getSysconfigXmlFiles } from '../processor/sysconfig'
import { ApexManifest } from '../proto-ts/system/apex/proto/apex_manifest'
import {
  CheckinReasonCode,
  CheckinRequest,
  CheckinResponse,
  CheckinRestriction,
  DeviceFormFactor,
  FeatureWithVersion,
  GuestType,
  IccLockState,
  KeyboardType,
  NavigationType,
  ScreenLayout,
  TouchscreenType,
} from '../proto-ts/vendor/adevtool/assets/checkin'
import { getBriefPackageInfo } from '../util/aapt2'
import { isDirectory, isFile, listFilesRecursive } from '../util/fs'
import { log } from '../util/log'
import { ALL_SYS_PARTITIONS, Partition, PathResolver } from '../util/partitions'
import { spawnAsyncStdin } from '../util/process'
import { listPart } from './file-list'
import {
  BASEBAND_VERSION_PROP,
  BOOT_HARDWARE_PROP,
  BOOTLOADER_VERSION_PROP,
  BUILD_DATE_UTC_PROP,
  BUILD_FINGERPRINT_PROP,
  BUILD_ID_PROP,
  BUILD_PROP_PARTITION_PRECEDENCE,
  BUILD_TAGS_PROP,
  BUILD_TYPE_PROP,
  BUILD_VERSION_INCREMENTAL_PROP,
  BUILD_VERSION_RELEASE_OR_CODENAME_PROP,
  BUILD_VERSION_SDK_PROP,
  BUILD_VERSION_SECURITY_PATCH_PROP,
  HARDWARE_PROP,
  INCREMENTAL_ENABLE_PROP,
  loadPartitionProps,
  LOW_RAM_PROP,
  MULTI_SIM_CONFIG_PROP,
  OPENGL_ES_VERSION_PROP,
  PartitionProps,
  PRODUCT_CPU_ABILIST_PROP,
  PRODUCT_FIRST_API_LEVEL_PROP,
  RO_CPU_ABILIST_SOURCE_ORDER,
  RO_PRODUCT_PROPS_DEFAULT_SOURCE_ORDER,
  SCREEN_DENSITY_PROP,
} from './props'

const CHECKIN_URL = 'https://android.clients.google.com/checkin'
const CHECKIN_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_TIMEZONE_ID = 'America/New_York'
const NETWORK_CONNECTIVITY_INFO_WIFI = 'WIFI::'
const PIXEL_KEY_ATTESTATION_HARDWARE_REVISION = 'MP1.0'
const PUBLIC_LIBRARY_SUFFIXED_PARTITIONS: readonly Partition[] = [
  Partition.System,
  Partition.SystemExt,
  Partition.Product,
]
const EROFS_FSTAB_PARTITIONS: readonly Partition[] = [Partition.System, Partition.Vendor]
const SYSCONFIG_FEATURE_LIBRARY_PARTITIONS: readonly Partition[] = [
  Partition.System,
  Partition.Vendor,
  Partition.Odm,
  Partition.Product,
  Partition.SystemExt,
]
const CHECKIN_APEX_SOURCE_PARTITIONS: readonly Partition[] = SYSCONFIG_FEATURE_LIBRARY_PARTITIONS

// Runtime mount names mirror the android.os.Environment roots SystemConfig
// reads when loading sysconfig/permissions XML:
// frameworks/base/services/core/java/com/android/server/SystemConfig.java#readAllPermissionsFromXml()
// frameworks/base/core/java/android/os/Environment.java#getRootDirectory()
// frameworks/base/core/java/android/os/Environment.java#getVendorDirectory()
// frameworks/base/core/java/android/os/Environment.java#getOdmDirectory()
// frameworks/base/core/java/android/os/Environment.java#getProductDirectory()
// frameworks/base/core/java/android/os/Environment.java#getSystemExtDirectory()
// Environment.java backs those accessors with /system, /vendor, /odm,
// /product, and /system_ext respectively.
const RUNTIME_MOUNT_PARTITIONS: Record<string, Partition> = {
  system: Partition.System,
  vendor: Partition.Vendor,
  odm: Partition.Odm,
  product: Partition.Product,
  system_ext: Partition.SystemExt,
}

function getProp(props: PartitionProps, key: string): string | undefined {
  for (let partition of BUILD_PROP_PARTITION_PRECEDENCE) {
    let v = props.get(partition)?.get(key)
    if (v !== undefined && v !== '') {
      return v
    }
  }
  return undefined
}

function getRecoveryProp(props: PartitionProps, key: string): string | undefined {
  let v = props.get(Partition.Recovery)?.get(key)
  return v === '' ? undefined : v
}

function getMultiSimConfig(props: PartitionProps): string | undefined {
  // Early-boot vendor ramdisk prop.default can seed persist.radio.multisim.config
  // before the persisted /data/property value exists.
  return getProp(props, MULTI_SIM_CONFIG_PROP) ?? getRecoveryProp(props, MULTI_SIM_CONFIG_PROP)
}

function getActiveModemCountFromMultiSimConfig(multiSimConfig: string | undefined, hasCellular: boolean): number {
  // Mirrors Android framework telephony slot-count logic:
  // frameworks/base/telephony/java/android/telephony/TelephonyManager.java#getMultiSimConfiguration()
  // reads persist.radio.multisim.config, and
  // frameworks/base/telephony/java/android/telephony/TelephonyManager.java#getActiveModemCount()
  // maps that configuration to the number of active modems, falling back to one
  // modem for cellular-capable devices when the property is unset or unknown.
  if (!hasCellular) {
    return 0
  }
  switch (multiSimConfig) {
    case 'dsds':
    case 'dsda':
      return 2
    case 'tsts':
      return 3
    default:
      return 1
  }
}

function buildRadioVersion(props: PartitionProps, hasCellular: boolean): string {
  let basebandVersion = getProp(props, BASEBAND_VERSION_PROP) ?? ''
  if (basebandVersion === '') {
    return ''
  }

  let activeModemCount = getActiveModemCountFromMultiSimConfig(getMultiSimConfig(props), hasCellular)
  return Array(activeModemCount).fill(basebandVersion).join(',')
}

// SHA-1 of the empty byte array, prefixed with "1-". This is what initial
// checkin requests send and what the server's Gservices provider emits for an
// empty `main` table.
const FIRST_BOOT_DIGEST = '1-da39a3ee5e6b4b0d3255bfef95601890afd80709'

interface ScreenLayoutFields {
  screenLayout: ScreenLayout
  screenWidthPx: number
  screenHeightPx: number
  smallestScreenWidthDp: number
  screenLayoutLegacy: ScreenLayout
}

function screenLayoutSizeFromDp(widthDp: number, heightDp: number): ScreenLayout {
  let shortDp = Math.min(widthDp, heightDp)
  let longDp = Math.max(widthDp, heightDp)
  if (longDp < 470) {
    return ScreenLayout.SCREENLAYOUT_SMALL
  }
  if (longDp >= 960 && shortDp >= 720) {
    return ScreenLayout.SCREENLAYOUT_XLARGE
  }
  if (longDp >= 640 && shortDp >= 480) {
    return ScreenLayout.SCREENLAYOUT_LARGE
  }
  return ScreenLayout.SCREENLAYOUT_NORMAL
}

function stableDisplayDp(px: number, densityDpi: number) {
  return Math.floor((px * 160) / densityDpi)
}

function configurationDp(px: number, densityDpi: number) {
  return Math.floor((px * 160) / densityDpi + 0.5)
}

/**
 * Derives the display-related checkin fields using the same split as GmsCore:
 * DisplayManager.getStableDisplaySize() provides the reported stable pixel
 * dimensions and the physical-size screen_layout bucket, while
 * Resources.Configuration provides smallest_screen_width_dp and
 * screen_layout_legacy. Folded foldables can report smaller
 * Resources.Configuration values. Synthetic checkin is generated for the
 * unfolded/stable display, so the Configuration-derived fields are derived
 * from stable_display_size too.
 */
function deriveCheckinDisplayConfiguration(stableDisplaySize: DisplaySize, densityDpi: number): ScreenLayoutFields {
  let screenWidthPx = Math.min(stableDisplaySize.width, stableDisplaySize.height)
  let screenHeightPx = Math.max(stableDisplaySize.width, stableDisplaySize.height)
  let configurationDisplaySize = stableDisplaySize
  let configurationWidthDp = configurationDp(configurationDisplaySize.width, densityDpi)
  let configurationHeightDp = configurationDp(configurationDisplaySize.height, densityDpi)

  return {
    screenLayout: screenLayoutSizeFromDp(
      stableDisplayDp(screenWidthPx, densityDpi),
      stableDisplayDp(screenHeightPx, densityDpi),
    ),
    screenWidthPx,
    screenHeightPx,
    smallestScreenWidthDp: Math.min(configurationWidthDp, configurationHeightDp),
    screenLayoutLegacy: screenLayoutSizeFromDp(configurationWidthDp, configurationHeightDp),
  }
}

function synthRoProduct(props: PartitionProps, name: string): string | undefined {
  let direct = getProp(props, `ro.product.${name}`)
  if (direct) {
    return direct
  }
  for (let source of RO_PRODUCT_PROPS_DEFAULT_SOURCE_ORDER) {
    let v = getProp(props, `ro.product.${source}.${name}`)
    if (v) {
      return v
    }
  }
  return undefined
}

function deriveBuildFingerprint(props: PartitionProps): string | undefined {
  let direct = getProp(props, BUILD_FINGERPRINT_PROP)
  if (direct) {
    return direct
  }
  let brand = synthRoProduct(props, 'brand')
  let device = synthRoProduct(props, 'device')
  let name = synthRoProduct(props, 'name')
  let release = getProp(props, BUILD_VERSION_RELEASE_OR_CODENAME_PROP)
  let id = getProp(props, BUILD_ID_PROP)
  let incremental = getProp(props, BUILD_VERSION_INCREMENTAL_PROP)
  let type = getProp(props, BUILD_TYPE_PROP)
  let tags = getProp(props, BUILD_TAGS_PROP)
  if (brand && device && name && release && id && incremental && type && tags) {
    return `${brand}/${name}/${device}:${release}/${id}/${incremental}:${type}/${tags}`
  }
  return undefined
}

// Mirrors GmsCore with has_cellular as the Pixel-only static
// proxy for TelephonyManager.getPhoneType() being GSM or CDMA.
function deriveDeviceFormFactor(
  productName: string | undefined,
  features: ReadonlySet<string>,
  hasCellular: boolean,
  layout: ScreenLayoutFields,
): DeviceFormFactor {
  if (productName?.startsWith('glass_')) {
    return DeviceFormFactor.GLASS
  }
  if (features.has('android.hardware.type.embedded')) {
    return DeviceFormFactor.THINGS
  }
  if (features.has('com.google.desktop.gms')) {
    return DeviceFormFactor.DESKTOP
  }

  let isTabletShape = layout.screenLayout === ScreenLayout.SCREENLAYOUT_XLARGE || layout.smallestScreenWidthDp >= 600
  let isPhoneShaped =
    features.has('android.hardware.sensor.hinge_angle') ||
    !(isTabletShape || features.has('org.chromium.arc') || features.has('com.google.android.feature.AMATI_EXPERIENCE'))
  if (hasCellular && isPhoneShaped) {
    return DeviceFormFactor.PHONE
  }

  if (isTabletShape) {
    return DeviceFormFactor.TABLET
  }
  return DeviceFormFactor.FORM_FACTOR_OTHER
}

function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

// Compute the same `ota_cert` strings the GMS request builder emits: for
// each entry in /system/etc/security/otacerts.zip, SHA-1 of the entry's
// uncompressed bytes, base64 (no-wrap, with `=` padding).
async function computeOtaCerts(resolver: PathResolver): Promise<string[]> {
  let zipPath = resolver.resolve(Partition.System, 'etc/security/otacerts.zip')
  if (!(await isFile(zipPath))) {
    return []
  }
  let result: string[] = []
  let zip = await yauzl.open(zipPath)
  try {
    // Preserve ZIP entry iteration order to match GmsCore. Current Pixel
    // otacerts.zip files have one cert in practice.
    for await (let entry of zip) {
      if (entry.filename.endsWith('/')) {
        continue
      }
      let stream = await entry.openReadStream()
      let chunks: Buffer[] = []
      for await (let chunk of stream) {
        chunks.push(chunk as Buffer)
      }
      result.push(await hasha.async(Buffer.concat(chunks), { algorithm: 'sha1', encoding: 'base64' }))
    }
  } finally {
    await zip.close()
  }
  return result
}

export interface GenerateCheckinRequestArgs {
  imageRoot: string
  deviceConfig: DeviceConfig
  serial?: string
  timezoneId?: string
  locale?: string
  odmSku?: string
  oemKey?: string
}

// 16-character uppercase-hex random serial. Matches the format Pixel devices
// emit (e.g. `49091FDAQ001WH`) closely enough for synthetic checkins; the
// server rejects empty / "unknown" serials but does not validate the format.
export function randomHexSerial(): string {
  return crypto.randomBytes(8).toString('hex').toUpperCase()
}

// XML parser used for sysconfig <feature>/<library> extraction. preserveOrder
// matches the rest of adevtool's XML usage; non-trivial parts of the resulting
// shape (per-element `:@` attribute object, single-key element nodes) are
// handled by the recursive walker below.
const sysconfigXmlParser = new XMLParser({
  preserveOrder: true,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreAttributes: false,
})

interface SysconfigElement {
  tag: string
  attrs: Record<string, string>
}

function* walkSysconfigElements(nodes: unknown[]): Generator<SysconfigElement> {
  for (let node of nodes) {
    if (typeof node !== 'object' || node === null) {
      continue
    }
    let tag = Object.keys(node).find(key => key !== ':@')
    if (tag === undefined) {
      continue
    }
    let attrs = ((node as Record<string, unknown>)[':@'] ?? {}) as Record<string, string>
    yield { tag, attrs }
    let children = (node as Record<string, unknown>)[tag]
    if (Array.isArray(children)) {
      yield* walkSysconfigElements(children)
    }
  }
}

interface RuntimePathContext {
  resolver: PathResolver
  apexDirsByName: Map<string, string>
}

async function getCheckinUnpackedApexDirs(resolver: PathResolver): Promise<string[]> {
  let result: string[] = []
  for (let partition of CHECKIN_APEX_SOURCE_PARTITIONS) {
    let apexRoot = resolver.resolveUnpackedApexPath(partition, 'apex')
    if (!(await isDirectory(apexRoot))) {
      continue
    }
    for (let entry of await fs.readdir(apexRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        result.push(path.join(apexRoot, entry.name))
      }
    }
  }
  return result.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

async function getCheckinApexPermissionXmlPaths(resolver: PathResolver): Promise<string[]> {
  let apexDirs = await getCheckinUnpackedApexDirs(resolver)
  let xmlPathGroups = await Promise.all(
    apexDirs.map(async apexDir => {
      let permissionsDir = path.join(apexDir, 'etc', 'permissions')
      if (!(await isDirectory(permissionsDir))) {
        return []
      }
      return (await fs.readdir(permissionsDir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.xml'))
        .map(entry => path.join(permissionsDir, entry.name))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    }),
  )
  return xmlPathGroups.flat()
}

// This can become a shared unpacked-APEX runtime-name index for the rest of
// adevtool if other processors need to resolve /apex/<manifest.name> paths.
// If duplicate manifest names exist across partitions, the last one wins here;
// apexd normally only activates one package for a given runtime mount name.
async function loadApexDirsByName(resolver: PathResolver): Promise<Map<string, string>> {
  let result = new Map<string, string>()
  for (let apexDir of await getCheckinUnpackedApexDirs(resolver)) {
    let apexDirName = path.basename(apexDir)
    result.set(apexDirName, apexDir)
    for (let suffix of ['.apex', '.capex']) {
      if (apexDirName.endsWith(suffix)) {
        result.set(apexDirName.slice(0, -suffix.length), apexDir)
      }
    }

    let manifestPath = path.join(apexDir, 'apex_manifest.pb')
    try {
      let manifest = ApexManifest.decode(await fs.readFile(manifestPath))
      if (manifest.name) {
        result.set(manifest.name, apexDir)
      }
    } catch (e) {
      console.warn(`warning: failed to decode APEX manifest ${manifestPath}: ${errorMessage(e)}`)
    }
  }
  return result
}

// Mirror runtime-mount path resolution against the unpacked image. APEX
// entries use ApexManifest.name as the /apex/<name> mount point, which can
// differ from the unpacked directory name:
// system/apex/apexd/apex_file.h#GetManifest()
// system/apex/apexd/apex_manifest.cpp#GetPackageId()
// system/apex/apexd/apexd.cpp#GetPackageMountPoint()
// system/apex/apexd/apexd.cpp#GetActiveMountPoint()
// system/apex/apexd/apexd.cpp#ActivatePackageImpl()
function translateRuntimePath(ctx: RuntimePathContext, raw: string): string | undefined {
  if (!raw) {
    return undefined
  }
  if (!raw.startsWith('/')) {
    return path.resolve(ctx.resolver.basePath, raw)
  }
  let parts = raw.split('/').filter(p => p.length > 0)
  if (parts.length < 1) {
    return undefined
  }
  let mount = parts[0]
  let suffix = parts.slice(1).join('/')
  if (mount === 'apex') {
    // Sysconfig XML references the active /apex/<manifest.name> bind mount.
    // apexd creates the versioned /apex/<name>@<version> mount with
    // GetPackageMountPoint(), then ActivatePackageImpl() bind-mounts it to
    // GetActiveMountPoint(), which is /apex/<manifest.name>.
    // Example: /apex/com.android.ipsec/javalib/android.net.ipsec.ike.jar
    // comes from the unpacked com.google.android.ipsec.apex directory, whose
    // ApexManifest name is com.android.ipsec. Resolving by the unpacked
    // directory name alone would look for com.android.ipsec and miss the
    // actual com.google.android.ipsec.apex directory.
    let apexName = parts[1]
    if (apexName === undefined) {
      return undefined
    }
    let apexDir = ctx.apexDirsByName.get(apexName)
    if (apexDir === undefined) {
      return undefined
    }
    return path.join(apexDir, parts.slice(2).join('/'))
  }
  let part = RUNTIME_MOUNT_PARTITIONS[mount]
  if (part === undefined) {
    return undefined
  }
  return ctx.resolver.resolve(part, suffix)
}

function propsIsTrue(props: PartitionProps, key: string): boolean {
  let v = getProp(props, key)?.toLowerCase()
  return v === '1' || v === 'true' || v === 'y' || v === 'yes' || v === 'on'
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function getOptionalPositiveIntegerProp(props: PartitionProps, key: string): number | undefined {
  let value = getProp(props, key)
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined
  }
  let parsed = parseInt(value, 10)
  return parsed > 0 ? parsed : undefined
}

function getRequiredPositiveIntegerProp(props: PartitionProps, key: string, purpose: string): number {
  let value = getProp(props, key)
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`No valid ${key} in build.prop; cannot ${purpose}`)
  }
  let parsed = parseInt(value, 10)
  if (parsed <= 0) {
    throw new Error(`No valid ${key} in build.prop; cannot ${purpose}`)
  }
  return parsed
}

async function imageUsesErofs(resolver: PathResolver): Promise<boolean> {
  for (let partition of EROFS_FSTAB_PARTITIONS) {
    let dir = resolver.resolve(partition, 'etc')
    if (!(await isDirectory(dir))) {
      continue
    }
    for (let name of await fs.readdir(dir)) {
      if (!name.startsWith('fstab')) {
        continue
      }
      let text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '')
      if (text.includes('erofs')) {
        return true
      }
    }
  }
  return false
}

// Mirror PMS's environment-derived feature additions: features added in
// runtime code (PackageManagerService / SystemConfig) rather than declared
// in any sysconfig XML. Returns name -> minimum-version pairs (max()-merged
// with version values from XML <feature> entries).
function inferEnvironmentFeatures(props: PartitionProps, sdkVersion: number, usesErofs: boolean): Map<string, number> {
  let out = new Map<string, number>()
  let deviceInitialSdkVersion = getOptionalPositiveIntegerProp(props, PRODUCT_FIRST_API_LEVEL_PROP) ?? sdkVersion
  // SystemConfig uses StorageManager.isFileEncrypted() for these features at runtime.
  // Current Pixels launch with Android 10+ and are required to use file-based encryption:
  // https://source.android.com/docs/security/features/encryption/file-based
  const storageManagerIsFileEncrypted = deviceInitialSdkVersion >= 29;
  if (storageManagerIsFileEncrypted) {
    out.set('android.software.file_based_encryption', 0)
    out.set('android.software.securely_removes_users', 0)
    // SystemConfig adds android.software.ipsec_tunnels from
    // Build.VERSION.DEVICE_INITIAL_SDK_INT, which is ro.product.first_api_level:
    // frameworks/base/core/java/android/os/Build.java#VERSION.DEVICE_INITIAL_SDK_INT
    // frameworks/base/services/core/java/com/android/server/SystemConfig.java#readAllPermissionsFromEnvironment()
    out.set('android.software.ipsec_tunnels', 0)
  } else {
    log(
      `warning: device initial SDK ${deviceInitialSdkVersion} is below 29; ` +
        `not inferring Android 10 launch features`,
    )
  }
  if (propsIsTrue(props, LOW_RAM_PROP)) {
    out.set('android.hardware.ram.low', 0)
  } else {
    out.set('android.hardware.ram.normal', 0)
  }
  if (propsIsTrue(props, INCREMENTAL_ENABLE_PROP)) {
    // SystemConfig uses IncrementalManager.getVersion(); the factory image does
    // not expose that runtime value directly, so use ro.incremental.enable as a
    // Pixel proxy and report the minimum nonzero feature version.
    out.set('android.software.incremental_delivery', 1)
  }
  out.set('android.software.app_enumeration', 0)
  if (usesErofs) {
    // SystemConfig only adds android.software.erofs on kernels >= 5.10.
    // The Android common kernels page lists Android 12+ Pixel-era branches
    // starting at android12-5.10, so the fstab check is enough for current
    // Pixels but is not a complete framework mirror:
    // https://source.android.com/docs/core/architecture/kernel/android-common
    out.set('android.software.erofs', 0)
  }
  return out
}

function getSystemConfigSkuSubdirs(sku: string | undefined): Partial<Record<Partition, readonly string[]>> | undefined {
  if (sku === undefined || sku === '') {
    return undefined
  }

  let skuDir = `sku_${sku}`
  return {
    [Partition.Vendor]: [skuDir],
    [Partition.Odm]: [skuDir],
    [Partition.Product]: [skuDir],
  }
}

async function getBriefPackageInfoOrWarn(aapt2: string, sdkVersion: string, apkPath: string) {
  try {
    return await getBriefPackageInfo(aapt2, sdkVersion, apkPath)
  } catch (e) {
    let msg = errorMessage(e)
    console.warn(`warning: failed to parse APK ${apkPath}: ${msg}`)
    let normalizedPath = apkPath.toLowerCase()
    if (normalizedPath.includes('gmscore') || normalizedPath.includes('prebuiltgms')) {
      throw new Error(`failed to parse likely GmsCore APK ${apkPath}: ${msg}`)
    }
    return undefined
  }
}

// Read native-library sonames from `vendor/etc/public.libraries.txt` and
// `{system,system_ext,product}/etc/public.libraries-*.txt`. Mirrors
// SystemConfig.readPublicNativeLibrariesList(). The framework only reads the literal
// `public.libraries.txt` from /vendor, and only `public.libraries-<suffix>.txt` from the other
// partitions (the bare-name ones in /system are probably bionic linker-only).
async function readPublicLibrarySonames(resolver: PathResolver): Promise<string[]> {
  let files: string[] = []
  let vendorFile = resolver.resolve(Partition.Vendor, 'etc/public.libraries.txt')
  if (await isFile(vendorFile)) {
    files.push(vendorFile)
  }
  for (let partition of PUBLIC_LIBRARY_SUFFIXED_PARTITIONS) {
    let dir = resolver.resolve(partition, 'etc')
    if (!(await isDirectory(dir))) {
      continue
    }
    for (let name of await fs.readdir(dir)) {
      if (name.startsWith('public.libraries-') && name.endsWith('.txt')) {
        files.push(path.join(dir, name))
      }
    }
  }
  let out: string[] = []
  for (let file of files) {
    let text = await fs.readFile(file, 'utf8').catch(() => '')
    for (let line of text.split('\n')) {
      let t = line.trim()
      if (!t || t.startsWith('#')) {
        continue
      }
      let soname = t.split(/\s+/)[0]
      if (soname) {
        out.push(soname)
      }
    }
  }
  return out
}

// Iterate every APK shipped in the unpacked image: walks ALL_SYS_PARTITIONS
// for *.apk files, excluding overlay APKs and framework-res, plus every .apk
// under unpacked_apexes/. Mirrors the iteration in src/frontend/generate.ts.
function isFrameworkResourceApk(f: { partition: Partition; relPath: string }): boolean {
  return f.partition === Partition.System && f.relPath === 'framework/framework-res.apk'
}

function isIncludedImageApkPath(f: { partition: Partition; relPath: string }): boolean {
  if (!f.relPath.endsWith('.apk')) {
    return false
  }
  if (f.relPath.startsWith('overlay/')) {
    return false
  }
  return !isFrameworkResourceApk(f)
}

async function iterImageApkPaths(resolver: PathResolver): Promise<string[]> {
  let out: string[] = []
  for (let partition of ALL_SYS_PARTITIONS) {
    let files = await listPart(partition, resolver)
    if (files === null) {
      continue
    }
    for (let f of files) {
      if (isIncludedImageApkPath(f)) {
        out.push(f.resolve(resolver))
      }
    }
  }
  let apexRoot = resolver.getUnpackedApexDir()
  if (await isDirectory(apexRoot)) {
    for await (let p of listFilesRecursive(apexRoot)) {
      if (p.endsWith('.apk')) {
        out.push(p)
      }
    }
  }
  return out
}

export interface CollectFeaturesAndLibrariesArgs {
  resolver: PathResolver
  props: PartitionProps
  sdkVersion: string
  sku?: string
}

export interface CollectFeaturesAndLibrariesResult {
  features: string[]
  featuresWithVersion: FeatureWithVersion[]
  libraries: string[]
  // versionCode of the APK with packageName == "com.google.android.gms",
  // or undefined if no such APK is shipped on this image.
  gmsVersionCode?: number
}

// Reconstruct what the framework would return from
// `PackageManager.getSystemAvailableFeatures()` and
// `getSystemSharedLibraryNames()` on first boot of this image. Three sources
// for libraries (sysconfig <library>/<apex-library> + public.libraries-*.txt
// + APK <library> elements via BriefPackageInfo) and two for features
// (sysconfig <feature> minus <unavailable-feature> + environment-derived).
export async function collectFeaturesAndLibraries(
  args: CollectFeaturesAndLibrariesArgs,
): Promise<CollectFeaturesAndLibrariesResult> {
  let { resolver, props, sdkVersion } = args

  let featureVersions = new Map<string, number>()
  let unavailableFeatures = new Set<string>()
  let libraries = new Set<string>()
  let lowRam = propsIsTrue(props, LOW_RAM_PROP)
  let runtimePathContext: RuntimePathContext = {
    resolver,
    apexDirsByName: await loadApexDirsByName(resolver),
  }

  // SystemConfig reads sysconfig and permissions XML from the runtime-mounted
  // system/product/vendor/odm/system_ext partitions. dlkm, ramdisk, recovery,
  // and boot-image partitions are not part of this config surface. Vendor,
  // ODM, and product also have SKU-specific subdirectories when the matching
  // boot SKU properties are present. For Pixels, the configured hardware SKU
  // corresponds to ro.boot.hardware.sku; init scripts also copy it to
  // ro.boot.product.hardware.sku. Current Pixel factory images only appear to
  // use ODM SKU sysconfig dirs, for example
  // shiba-CP21.260306.017/vendor/odm/etc/sysconfig/sku_GZPF0/felica_feature.xml,
  // but vendor/product are included because SystemConfig supports them.
  // frameworks/base/services/core/java/com/android/server/SystemConfig.java#readAllPermissionsFromXml()
  // platform.xml is processed last to mirror framework layering, although it's
  // likely order doesn't matter in practice.
  let sysconfigXmlPaths = (
    await getSysconfigXmlFiles(resolver, {
      dirNames: ['sysconfig', 'permissions'],
      partitions: SYSCONFIG_FEATURE_LIBRARY_PARTITIONS,
      partitionSubdirs: getSystemConfigSkuSubdirs(args.sku),
      platformLast: true,
    })
  ).map(xmlFile => xmlFile.path)
  // SystemConfig also reads permissions XML from all active /apex mounts.
  // Checkin needs more than system APEXes: rango's stock request includes
  // android.hardware.thread_network from
  // vendor/apex/com.google.rango.hardware.threadnetwork.apex/etc/permissions/android.hardware.thread_network.prebuilt.xml.
  sysconfigXmlPaths.push(...(await getCheckinApexPermissionXmlPaths(resolver)))

  for (let xmlPath of sysconfigXmlPaths) {
    let text: string
    try {
      text = await fs.readFile(xmlPath, 'utf8')
    } catch (e) {
      throw new Error(`failed to read sysconfig XML ${xmlPath}: ${errorMessage(e)}`)
    }
    let parsed: unknown
    try {
      parsed = sysconfigXmlParser.parse(text)
    } catch (e) {
      throw new Error(`failed to parse sysconfig XML ${xmlPath}: ${errorMessage(e)}`)
    }
    if (!Array.isArray(parsed)) {
      continue
    }
    for (let { tag, attrs } of walkSysconfigElements(parsed)) {
      if (tag === 'feature') {
        let name = attrs['@_name']
        if (!name) {
          continue
        }
        if (lowRam && attrs['@_notLowRam'] === 'true') {
          continue
        }
        let version = parseInt(attrs['@_version'] ?? '0', 10) || 0
        featureVersions.set(name, Math.max(version, featureVersions.get(name) ?? 0))
      } else if (tag === 'unavailable-feature') {
        let name = attrs['@_name']
        if (name) {
          unavailableFeatures.add(name)
        }
      } else if (tag === 'library' || tag === 'apex-library') {
        let name = attrs['@_name']
        let file = attrs['@_file']
        if (!name || !file) {
          continue
        }
        // SystemConfig.java#readLibrary() also gates libraries on
        // min-device-sdk/max-device-sdk. Current Pixel library entries do not
        // use those attributes; add that check here if they appear.
        let translated = translateRuntimePath(runtimePathContext, file)
        if (translated !== undefined && (await isFile(translated))) {
          libraries.add(name)
        }
      }
    }
  }

  let sdkVersionNumber = parseInt(sdkVersion, 10) || 0
  let usesErofs = await imageUsesErofs(resolver)
  for (let [name, version] of inferEnvironmentFeatures(props, sdkVersionNumber, usesErofs)) {
    featureVersions.set(name, Math.max(version, featureVersions.get(name) ?? 0))
  }

  // SystemConfig applies <unavailable-feature> removals after XML and
  // environment-derived features:
  // frameworks/base/services/core/java/com/android/server/SystemConfig.java#readAllPermissions()
  for (let n of unavailableFeatures) {
    featureVersions.delete(n)
  }

  for (let soname of await readPublicLibrarySonames(resolver)) {
    libraries.add(soname)
  }

  let aapt2 = await getHostBinPath('aapt2')
  let apkPaths = await iterImageApkPaths(resolver)
  let bpiResults = await Promise.all(apkPaths.map(p => getBriefPackageInfoOrWarn(aapt2, sdkVersion, p)))
  let gmsVersionCode: number | undefined
  for (let bpi of bpiResults) {
    if (bpi === undefined) {
      continue
    }
    for (let name of bpi.library) {
      if (name) {
        libraries.add(name)
      }
    }
    if (bpi.packageName === 'com.google.android.gms' && gmsVersionCode === undefined) {
      // BriefPackageInfo.versionCode is int64 (proto) -> number (ts-proto).
      // GmsCore versionCodes fit in int32 in practice (current ~254M); the
      // proto field on CheckinRequest is `int32 gms_version_code`.
      gmsVersionCode = Number(bpi.versionCode)
    }
  }

  let features = [...featureVersions.keys()].sort()
  let featuresWithVersion: FeatureWithVersion[] = features.map(name => ({
    featureName: name,
    version: featureVersions.get(name) ?? 0,
  }))
  let libs = [...libraries].sort()
  return { features, featuresWithVersion, libraries: libs, gmsVersionCode }
}

/**
 * Builds a first-checkin request matching Setup Wizard on stock OS with no physical SIM card.
 * Device identifiers such as IMEI and serial are omitted unless provided; Google could use
 * them when selecting Gservices flags.
 */
export async function buildCheckinRequest(args: GenerateCheckinRequestArgs): Promise<CheckinRequest> {
  let resolver = new PathResolver(args.imageRoot)
  let props = await loadPartitionProps(resolver)
  let deviceConfig = args.deviceConfig
  let codename = deviceConfig.device.name
  let stableDisplaySize = deviceConfig.device.stable_display_size
  if (stableDisplaySize === undefined) {
    throw new Error(
      `${codename}: device.stable_display_size is required for update-gservices-flags; ` +
        `add a { width, height } entry to config/device/${codename}.yml`,
    )
  }

  let buildFingerprint = deriveBuildFingerprint(props) ?? ''
  let hardware = getProp(props, HARDWARE_PROP) ?? getProp(props, BOOT_HARDWARE_PROP) ?? codename
  let brand = synthRoProduct(props, 'brand') ?? 'google'
  let device = synthRoProduct(props, 'device') ?? codename
  let manufacturer = synthRoProduct(props, 'manufacturer') ?? 'Google'
  let model = synthRoProduct(props, 'model') ?? ''
  let product = synthRoProduct(props, 'name') ?? codename
  let sdkVersion = getRequiredPositiveIntegerProp(props, BUILD_VERSION_SDK_PROP, 'synthesize checkin request')
  let buildTimeSeconds = getRequiredPositiveIntegerProp(props, BUILD_DATE_UTC_PROP, 'synthesize checkin request')
  let securityPatch = getProp(props, BUILD_VERSION_SECURITY_PATCH_PROP) ?? ''
  let bootloaderVersion = getProp(props, BOOTLOADER_VERSION_PROP) ?? ''
  let radioVersion = buildRadioVersion(props, deviceConfig.device.has_cellular)
  let lowRam = propsIsTrue(props, LOW_RAM_PROP)

  let densityDpi = getRequiredPositiveIntegerProp(props, SCREEN_DENSITY_PROP, 'compute screen layout')
  let layout = deriveCheckinDisplayConfiguration(stableDisplaySize, densityDpi)

  let glEsVersion = getRequiredPositiveIntegerProp(props, OPENGL_ES_VERSION_PROP, 'synthesize checkin request')
  let otaCerts = await computeOtaCerts(resolver)
  let sdkVersionStr = String(sdkVersion)
  let { features, featuresWithVersion, libraries, gmsVersionCode } = await collectFeaturesAndLibraries({
    resolver,
    props,
    sdkVersion: sdkVersionStr,
    sku: args.odmSku,
  })
  let featureSet = new Set(features)

  // ro.product.cpu.abilist is the runtime-derived comma-joined value exposed
  // through Build.SUPPORTED_ABIS:
  // frameworks/base/core/java/android/os/Build.java#SUPPORTED_ABIS
  // frameworks/base/core/java/android/os/Build.java#getStringList()
  // Package manager ABI derivation consumes the same framework value:
  // frameworks/base/services/core/java/com/android/server/pm/PackageAbiHelperImpl.java#derivePackageAbi()
  // It maps 1:1 onto repeated DeviceConfiguration.native_platform. The bare
  // property does not appear directly in any per-partition build.prop; init
  // synthesizes it from `ro.<partition>.product.cpu.abilist{32,64}`:
  // system/core/init/property_service.cpp#property_initialize_ro_cpu_abilist()
  // system/core/init/property_service.cpp#PropertyLoadBootDefaults()
  // The <partition> prefix sits before `.product.cpu.abilist*`, unlike the
  // `ro.product.<source>.<name>` naming RO_PRODUCT_PROPS_DEFAULT_SOURCE_ORDER handles.
  // The first partition in RO_CPU_ABILIST_SOURCE_ORDER with a non-empty
  // abilist32 or abilist64 wins; result is abilist64 entries first, then
  // abilist32.
  let nativePlatform: string[] = []
  let directAbilist = getProp(props, PRODUCT_CPU_ABILIST_PROP)
  if (directAbilist) {
    nativePlatform = splitCommaList(directAbilist)
  } else {
    let abilist32 = ''
    let abilist64 = ''
    for (let partition of RO_CPU_ABILIST_SOURCE_ORDER) {
      let p = props.get(partition)
      if (p === undefined) {
        continue
      }
      let a32 = p.get(`ro.${partition}.product.cpu.abilist32`) ?? ''
      let a64 = p.get(`ro.${partition}.product.cpu.abilist64`) ?? ''
      if (a32 || a64) {
        abilist32 = a32
        abilist64 = a64
        break
      }
    }
    if (abilist64) {
      nativePlatform.push(...splitCommaList(abilist64))
    }
    if (abilist32) {
      nativePlatform.push(...splitCommaList(abilist32))
    }
  }

  // Some fields observed in real first-checkin requests are intentionally
  // omitted for now. mac_addr, network_interface_type, total_memory_bytes,
  // and cpu_core_count are runtime-derived; device_configuration.gl_extension
  // and system_supported_locale are statically derivable but not generated for simplicity.
  //
  // The server distinguishes "absent" from "explicit default" via proto2
  // presence. Every scalar default we care about is set explicitly below so
  // that ts-proto (built with noDefaultsForOptionals=true) emits it on the
  // wire. Missing any of these triggers HTTP 400 ["di", N] from the live
  // checkin server.
  return CheckinRequest.fromPartial({
    // proto2 int64 / fixed64 fields are typed as `string` because the proto
    // is regenerated with `forceLong=string` (see proto-ts/update.sh for
    // why).
    currentAndroidId: '0',
    digest: FIRST_BOOT_DIGEST,
    payload: {
      deviceInfo: {
        buildFingerprint,
        hardware,
        brand,
        radioVersion,
        bootloaderVersion,
        buildTimeSeconds: String(buildTimeSeconds),
        gmsVersionCode,
        device,
        sdkVersion,
        model,
        manufacturer,
        product,
        recoveryFromBootPatchExists: false,
        securityPatch,
        odmSku: args.odmSku,
      },
      lastCheckinMsec: '0',
      networkConnectivityInfo: NETWORK_CONNECTIVITY_INFO_WIFI,
      userSerialNumber: 0,
      deviceFormFactor: deriveDeviceFormFactor(product, featureSet, deviceConfig.device.has_cellular, layout),
      checkinReason: {
        reason: CheckinReasonCode.STARTUP_OR_MODULE_UPDATE,
        retryCount: 1,
        sourcePackage: 'unspecified',
        sourceClass: '',
        force: false,
      },
      isVoiceCapable: deviceConfig.device.has_cellular,
      networkType: 'WIFI',
      iccLockState: IccLockState.ICC_LOCK_DISABLED,
      simCarrierId: -1,
    },
    accountAuthCookie: [''], // empty string means no Google accounts are present
    timezoneId: args.timezoneId ?? DEFAULT_TIMEZONE_ID,
    checkinProtocolVersion: 3,
    currentSecurityToken: '0',
    otaCert: otaCerts,
    serial: args.serial,
    locale: args.locale ?? 'en-US',
    euiccProvisioned: false,
    deviceConfiguration: {
      touchScreen: TouchscreenType.TOUCHSCREEN_FINGER,
      keyboard: KeyboardType.KEYBOARD_NOKEYS,
      navigation: NavigationType.NAVIGATION_NONAV,
      screenLayout: layout.screenLayout,
      hasHardKeyboard: false,
      hasFiveWayNavigation: false,
      screenDensityDpi: densityDpi,
      glEsVersion,
      nativePlatform,
      systemSharedLibrary: libraries,
      systemAvailableFeature: features,
      availableFeatureWithVersion: featuresWithVersion,
      // Simulate checkin from setup wizard?
      isDeviceSecure: false,
      oemKey: args.oemKey,
      screenWidthPx: layout.screenWidthPx,
      screenHeightPx: layout.screenHeightPx,
      smallestScreenWidthDp: layout.smallestScreenWidthDp,
      lowRamDevice: lowRam,
      screenLayoutLegacy: layout.screenLayoutLegacy,
    },
    fragmentIndex: 0,
    userSerialNumber: 0,
    checkinRestriction: CheckinRestriction.NO_RESTRICTION,
    fetchSystemUpdates: false,
    refreshAndroidId: false,
    guestType: GuestType.TYPE_UNKNOWN,
    isMainUser: true,
    isHeadlessSystemUserMode: false,
    // Real-device requests commonly include a `key_attestation` block. When
    // on-device key generation fails, the block contains a KeyAttestationError
    // instead of a cert chain. Use the Pixel failure shape as the synthetic
    // default when no Titan-M-attested chain is available.
    keyAttestation: {
      hardwareRevision: PIXEL_KEY_ATTESTATION_HARDWARE_REVISION,
      error: {
        errorCode: 8,
        errorMessage: 'Failed to generate key pair.',
      },
    },
  })
}

export interface CheckinHttpResponse {
  ok: boolean
  status: number
  statusText: string
  checkinError: string | null
  body: Buffer
}

export interface GservicesFlag {
  name: string
  value: string
}

// Filename heuristic for current Pixel backport config. If Google renames the
// Euicc APKs or moves them into a backport directory, update-gservices-flags
// callers can still override the selected build with --buildId.
function isGservicesBackportedEuiccApk(relPath: string) {
  if (!relPath.endsWith('.apk')) {
    return false
  }
  let apkName = path.basename(relPath, '.apk')
  return apkName.startsWith('EuiccGoogle') || apkName.startsWith('EuiccSupportPixel')
}

export function getDefaultGservicesBuildId(config: DeviceConfig) {
  let backportBuildId = config.device.backport_build_id
  if (backportBuildId === undefined) {
    return config.device.build_id
  }

  for (let files of Object.values(config.backport_files)) {
    if (files.some(isGservicesBackportedEuiccApk)) {
      return backportBuildId
    }
  }
  return config.device.build_id
}

export function getAllGservicesFlags(responseBinary: Buffer): GservicesFlag[] {
  let decoded = CheckinResponse.decode(responseBinary)
  let flagsByName = new Map<string, GservicesFlag>()
  for (let entry of decoded.gservicesEntry) {
    let name = Buffer.from(entry.name ?? new Uint8Array()).toString('utf8')
    if (name === '') {
      continue
    }
    flagsByName.set(name, {
      name,
      value: Buffer.from(entry.value ?? new Uint8Array()).toString('utf8'),
    })
  }
  return Array.from(flagsByName.values()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export function getFilteredGservicesFlags(config: DeviceConfig, responseBinary: Buffer): GservicesFlag[] {
  return getAllGservicesFlags(responseBinary).filter(entry => filterValue(config.device.gservices_flags, entry.name))
}

/**
 * Serializes gservices flags for plaintext storage
 * @param flags to serialize
 * @returns Multi-line string of the gservices flags serialized in format "name value"
 */
function serializeGservicesFlags(flags: GservicesFlag[]): string {
  return (
    flags.map(row => `${row.name} ${row.value.replaceAll('\n', '\\n')}`).join('\n') + (flags.length > 0 ? '\n' : '')
  )
}

export function getGservicesFlagsDir(config: DeviceConfig) {
  return path.join(GSERVICES_FLAGS_DIR, config.device.vendor, config.device.name)
}

export interface GservicesFlagsForSku {
  sku: string
  flags: GservicesFlag[]
}

/**
 * Filtered Gservices flags for one output target. When SKU responses are
 * identical, `sku` is the representative SKU and `sameSkus` lists the other
 * SKUs covered by the same serialized output.
 */
export interface GservicesFlagsOutputGroup {
  sku: string | undefined
  sameSkus: string[]
  flags: GservicesFlag[]
  serialized: string
}

/**
 * One Checkin request body to send or print. Generated requests keep the
 * structured `request`; textproto input only has `requestBinary`. Devices with
 * ODM SKUs produce one variant per SKU.
 */
export interface GservicesCheckinRequestVariant {
  sku: string | undefined
  label: string
  requestArgs?: GenerateCheckinRequestArgs
  request: CheckinRequest | undefined
  requestBinary: Buffer
  requestBodyPath: string | undefined
}

/**
 * Result of submitting one Checkin request variant, including the raw response
 * metadata and the filtered flags extracted from that response.
 */
export interface GservicesCheckinVariantResult extends GservicesCheckinRequestVariant {
  response: CheckinHttpResponse
  responseBodyPath: string | undefined
  filteredFlags: GservicesFlag[]
}

export interface UpdateGservicesFlagsResult {
  variants: GservicesCheckinVariantResult[]
  outFiles: string[]
  commonFlags: GservicesFlag[] | undefined
  flagsBySku: GservicesFlagsForSku[]
  filteredFlagGroups: GservicesFlagsOutputGroup[]
}

export interface GenerateGservicesCheckinRequestVariantsArgs {
  imageRoot: string
  deviceConfig: DeviceConfig
  serial?: string
  timezoneId?: string
  locale?: string
  debugDir?: string
}

export interface PostCheckinRequestArgs {
  requestBinary: Buffer
  request: CheckinRequest | undefined
}

async function writeGservicesFlagsFile(outFile: string, flags: GservicesFlag[]) {
  let tmpOutFile = `${outFile}.tmp`
  await fs.mkdir(path.dirname(outFile), { recursive: true })
  await fs.rm(tmpOutFile, { force: true })
  await fs.writeFile(tmpOutFile, serializeGservicesFlags(flags))
  await fs.rename(tmpOutFile, outFile)
}

function getSerializedGservicesFlagsForSkus(flagsBySku: GservicesFlagsForSku[]) {
  return flagsBySku.map(entry => ({
    sku: entry.sku,
    flags: entry.flags,
    serialized: serializeGservicesFlags(entry.flags),
  }))
}

function getGservicesFlagsOutputGroups(
  commonFlags: GservicesFlag[] | undefined,
  flagsBySku: GservicesFlagsForSku[],
): GservicesFlagsOutputGroup[] {
  if (flagsBySku.length === 0) {
    let flags = commonFlags ?? []
    return [
      {
        sku: undefined,
        sameSkus: [],
        flags,
        serialized: serializeGservicesFlags(flags),
      },
    ]
  }

  let serializedBySku = getSerializedGservicesFlagsForSkus(flagsBySku)
  let allIdentical = serializedBySku.every(entry => entry.serialized === serializedBySku[0].serialized)
  if (allIdentical) {
    let first = serializedBySku[0]
    return [
      {
        sku: first.sku,
        sameSkus: serializedBySku.slice(1).map(entry => entry.sku),
        flags: first.flags,
        serialized: first.serialized,
      },
    ]
  }

  return serializedBySku.map(entry => ({
    sku: entry.sku,
    sameSkus: [],
    flags: entry.flags,
    serialized: entry.serialized,
  }))
}

async function rmImmediateSubdirs(dir: string, keep: ReadonlySet<string> = new Set()) {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw err
  }
  await Promise.all(
    entries
      .filter(entry => entry.isDirectory() && !keep.has(entry.name))
      .map(entry => fs.rm(path.join(dir, entry.name), { recursive: true, force: true })),
  )
}

export async function writeGservicesFlags(config: DeviceConfig, flags: GservicesFlag[]) {
  let outDir = getGservicesFlagsDir(config)
  let outFile = path.join(outDir, 'flags.txt')
  await writeGservicesFlagsFile(outFile, flags)
  await rmImmediateSubdirs(outDir)
  return [outFile]
}

export async function writeGservicesFlagsForSkus(config: DeviceConfig, flagsBySku: GservicesFlagsForSku[]) {
  if (flagsBySku.length === 0) {
    return []
  }

  let outDir = getGservicesFlagsDir(config)
  let outputGroups = getGservicesFlagsOutputGroups(undefined, flagsBySku)
  if (outputGroups.length === 1) {
    let outFile = path.join(outDir, 'flags.txt')
    await writeGservicesFlagsFile(outFile, outputGroups[0].flags)
    await rmImmediateSubdirs(outDir)
    return [outFile]
  }

  await fs.mkdir(outDir, { recursive: true })
  await fs.rm(path.join(outDir, 'flags.txt'), { force: true })
  await fs.rm(path.join(outDir, 'flags.txt.tmp'), { force: true })

  let skus = new Set(flagsBySku.map(entry => entry.sku))
  await rmImmediateSubdirs(outDir, skus)

  let outFiles: string[] = []
  for (let entry of flagsBySku) {
    let outFile = path.join(outDir, entry.sku, 'flags.txt')
    await writeGservicesFlagsFile(outFile, entry.flags)
    outFiles.push(outFile)
  }
  return outFiles
}

// The checkin proto-ts bindings are generated with noDefaultsForOptionals=true
// (see proto-ts/update.sh), preserving explicit proto2 defaults on the wire.
function encodeCheckinRequest(request: CheckinRequest): Buffer {
  return Buffer.from(CheckinRequest.encode(request).finish())
}

/**
 * Builds the Checkin request variants used for Gservices fetches. Devices with
 * ODM SKUs get one request per SKU so SKU-specific server flags can be
 * detected; devices without SKUs use a single codename-labeled request. Each
 * SKU request is regenerated because SKU-specific sysconfig dirs can affect
 * the feature/library lists. This could be optimized by recomputing only the
 * SKU-sensitive sysconfig feature/library portion.
 */
export async function generateGservicesCheckinRequestVariants(
  args: GenerateGservicesCheckinRequestVariantsArgs,
): Promise<GservicesCheckinRequestVariant[]> {
  let skus = args.deviceConfig.device.odm_skus
  let variants = skus.length > 0 ? skus : [undefined]
  let codename = args.deviceConfig.device.name
  let result: GservicesCheckinRequestVariant[] = []
  let baseRequestArgs: GenerateCheckinRequestArgs = {
    imageRoot: args.imageRoot,
    deviceConfig: args.deviceConfig,
    serial: args.serial,
    timezoneId: args.timezoneId,
    locale: args.locale,
  }

  for (let sku of variants) {
    let requestArgs: GenerateCheckinRequestArgs =
      sku === undefined ? baseRequestArgs : { ...baseRequestArgs, odmSku: sku, oemKey: sku }
    let label = sku ?? codename
    let request = await buildCheckinRequest(requestArgs)
    let requestBinary = encodeCheckinRequest(request)
    let requestBodyPath: string | undefined
    if (args.debugDir !== undefined) {
      requestBodyPath = path.join(args.debugDir, `${codename}-${label}-checkin-request.body`)
      await fs.writeFile(requestBodyPath, requestBinary)
    }

    result.push({
      sku,
      label,
      requestArgs,
      request,
      requestBinary,
      requestBodyPath,
    })
  }

  return result
}

export async function updateGservicesFlagsFromRequestVariants(
  deviceConfig: DeviceConfig,
  variants: GservicesCheckinRequestVariant[],
  debugDir: string | undefined,
): Promise<UpdateGservicesFlagsResult> {
  if (variants.length === 0) {
    throw new Error('updateGservicesFlagsFromRequestVariants requires at least one request variant')
  }
  let codename = deviceConfig.device.name
  let results: GservicesCheckinVariantResult[] = []
  let commonFlags: GservicesFlag[] | undefined
  let flagsBySku: GservicesFlagsForSku[] = []

  for (let variant of variants) {
    let response = await postCheckinRequest({
      requestBinary: variant.requestBinary,
      request: variant.request,
    })
    let responseBinary = response.body
    let responseBodyPath: string | undefined
    if (debugDir !== undefined) {
      responseBodyPath = path.join(debugDir, `${codename}-${variant.label}-checkin-response.body`)
      await fs.writeFile(responseBodyPath, responseBinary)
    }

    if (!response.ok) {
      let detail = response.checkinError ?? response.statusText
      let bodyPreview = responseBinary.subarray(0, 512).toString('utf8')
      let responseBodyMessage =
        responseBodyPath !== undefined
          ? `Response body (${responseBinary.length} bytes) written to ${responseBodyPath}\n`
          : ''
      throw new Error(
        `HTTP ${response.status} from checkin server (${codename}${
          variant.sku === undefined ? '' : ` ${variant.sku}`
        }): ${detail}\n` +
          responseBodyMessage +
          `First 512 bytes: ${bodyPreview}`,
      )
    }

    let filteredFlags: GservicesFlag[]
    try {
      filteredFlags = getFilteredGservicesFlags(deviceConfig, responseBinary)
    } catch (e) {
      let responseBodyMessage =
        responseBodyPath !== undefined
          ? `Response body (${responseBinary.length} bytes) written to ${responseBodyPath}\n`
          : ''
      let detail = e instanceof Error ? e.message : String(e)
      throw new Error(
        `Failed to decode CheckinResponse from checkin server (${codename}${
          variant.sku === undefined ? '' : ` ${variant.sku}`
        }): ${detail}\n` + responseBodyMessage,
      )
    }
    if (variant.sku === undefined) {
      commonFlags = filteredFlags
    } else {
      flagsBySku.push({ sku: variant.sku, flags: filteredFlags })
    }

    results.push({
      ...variant,
      response,
      responseBodyPath,
      filteredFlags,
    })
  }

  let filteredFlagGroups = getGservicesFlagsOutputGroups(commonFlags, flagsBySku)
  let outFiles =
    flagsBySku.length > 0
      ? await writeGservicesFlagsForSkus(deviceConfig, flagsBySku)
      : await writeGservicesFlags(deviceConfig, commonFlags ?? [])

  return {
    variants: results,
    outFiles,
    commonFlags,
    flagsBySku,
    filteredFlagGroups,
  }
}

export async function postCheckinRequest(args: PostCheckinRequestArgs): Promise<CheckinHttpResponse> {
  // Generated variants keep the original ts-proto request so we don't need to
  // rebuild it just to derive the User-Agent. Some callers only have a request
  // body buffer, such as --textprotoFile input encoded by aprotoc, so fall back
  // to parsing the binary when the original generated request object is absent.
  let { requestBinary, request } = args
  let req = request ?? CheckinRequest.decode(requestBinary)
  let userAgent = deriveUserAgentFromRequest(req)
  let response = await fetch(CHECKIN_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(CHECKIN_REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/x-protobuffer',
      // Android clients gzip the request body and ask for gzip responses.
      'Content-Encoding': 'gzip',
      'Accept-Encoding': 'gzip',
      'User-Agent': userAgent,
    },
    body: zlib.gzipSync(requestBinary),
  })

  let responseBuffer = Buffer.from(await response.arrayBuffer())
  let responseBinary: Buffer
  if (response.headers.get('content-encoding') === 'gzip') {
    try {
      responseBinary = zlib.gunzipSync(responseBuffer)
    } catch {
      responseBinary = responseBuffer
    }
  } else {
    responseBinary = responseBuffer
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    checkinError: response.headers.get('checkin-error'),
    body: responseBinary,
  }
}

export async function decodeCheckinBinaryToTextproto(
  binary: Buffer,
  fullyQualifiedMessageName: 'android.checkin.CheckinRequest' | 'android.checkin.CheckinResponse',
): Promise<string> {
  let aprotoc = await getHostBinPath('aprotoc')
  let protoPath = path.join(ADEVTOOL_DIR, 'assets', 'checkin.proto')
  let protoDir = path.dirname(protoPath)
  return spawnAsyncStdin(
    aprotoc,
    [`--proto_path=${protoDir}`, `--decode=${fullyQualifiedMessageName}`, protoPath],
    binary,
  )
}

// Derive the Dalvik User-Agent that real Pixels emit, from a built CheckinRequest. Example format:
//   Dalvik/2.1.0 (Linux; U; Android 16; Pixel 9 Build/CP1A.260405.005)
// Release and build id come from the build fingerprint
// `<brand>/<name>/<device>:<release>/<id>/<incremental>:<type>/<tags>`.
export function deriveUserAgentFromRequest(req: CheckinRequest): string {
  let fingerprint = req.payload?.deviceInfo?.buildFingerprint ?? ''
  let model = req.payload?.deviceInfo?.model ?? ''
  let m = fingerprint.match(/^[^/]+\/[^/]+\/[^:]+:([^/]+)\/([^/]+)\//)
  let release = m?.[1] ?? ''
  let buildId = m?.[2] ?? ''
  return `Dalvik/2.1.0 (Linux; U; Android ${release}; ${model} Build/${buildId})`
}
