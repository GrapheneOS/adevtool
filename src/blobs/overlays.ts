import assert from 'assert'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { unzip, ZipEntry } from 'unzipit'
import xml2js from 'xml2js'

import { serializeBlueprint } from '../build/soong'
import { Filters, filterValue } from '../config/filters'
import { Configuration } from '../proto-ts/frameworks/base/tools/aapt2/Configuration'
import {
  Item,
  Reference_Type,
  ResourceTable,
  XmlAttribute,
  XmlNode,
} from '../proto-ts/frameworks/base/tools/aapt2/Resources'
import { exists, listFilesRecursive } from '../util/fs'
import { XML_HEADER } from '../util/headers'
import { EXT_PARTITIONS } from '../util/partitions'
import { spawnAsyncNoOut } from '../util/process'
import { NodeFileReader } from '../util/zip'

// Diff exclusions
const DIFF_EXCLUDE_TYPES = new Set(['raw', 'xml', 'color'])
const DIFF_MAP_PACKAGES = new Map([
  ['com.google.android.wifi.resources', 'com.android.wifi.resources'],
  ['com.google.android.connectivity.resources', 'com.android.connectivity.resources'],
  ['com.google.android.networkstack', 'com.android.networkstack'],
  ['com.google.android.networkstack.tethering', 'com.android.networkstack.tethering'],
  ['com.google.android.permissioncontroller', 'com.android.permissioncontroller'],
  ['com.google.android.uwb.resources', 'com.android.uwb.resources'],
])

const XML_BUILDER = new xml2js.Builder()

export type ResValue = number | boolean | string | Array<ResValue>

export interface ResKey {
  targetPkg: string
  targetName: string | null
  type: string
  key: string
  flags: string | null
}

export type ResValues = Map<string, ResValue>

export type PartResValues = { [part: string]: ResValues }

function encodeResKey(key: ResKey) {
  // pkg/name:type/key|flags
  return (
    `${key.targetPkg}${key.targetName?.length ? `/${key.targetName}` : ''}:` +
    `${key.type}/${key.key}${key.flags?.length ? `|${key.flags}` : ''}`
  )
}

export function decodeResKey(encoded: string) {
  let [tpn, tkf] = encoded.split(':')
  let [targetPkg, targetName] = tpn.split('/')
  let [type, kf] = tkf.split('/')
  let [key, flags] = kf.split('|')

  return {
    targetPkg,
    targetName: targetName != undefined ? targetName : null,
    type,
    key,
    flags: flags != undefined ? flags : null,
  } as ResKey
}

function toResKey(
  targetPkg: string,
  targetName: string | null,
  type: string | null,
  key: string | null,
  flags: string | null,
) {
  return encodeResKey({
    targetPkg,
    targetName,
    type: type!,
    key: key!,
    flags: flags!,
  })
}

async function parseOverlayApksRecursive(
  aapt2Path: string,
  partition: string,
  overlaysDir: string,
  pathCallback?: (path: string) => void,
  filters: Filters | null = null,
) {
  let values: ResValues = new Map<string, ResValue>()

  let tmpDir = fs.mkdtemp(path.join(tmpdir(), 'adevtool-overlay-parsing-'))
  try {
    let promises: Promise<ResValues | null>[] = []

    for await (let apkPath of listFilesRecursive(overlaysDir)) {
      if (path.extname(apkPath) != '.apk') {
        continue
      }

      if (filters != null && !filterValue(filters, path.relative(overlaysDir, apkPath))) {
        continue
      }

      promises.push(loadApkResValues(aapt2Path, partition, apkPath, await tmpDir))
    }

    for await (let resValues of promises) {
      if (resValues === null) {
        continue
      }
      // Merge overlayed values
      for (let [key, value] of resValues) {
        values.set(key, value)
      }
    }
  } finally {
    await fs.rm(await tmpDir, { recursive: true })
  }

  return values
}

export async function parsePartOverlayApks(
  aapt2Path: string,
  root: string,
  pathCallback?: (path: string) => void,
  filters: Filters | null = null,
) {
  let partValues: PartResValues = {}

  for (let partition of EXT_PARTITIONS) {
    let src = `${root}/${partition}/overlay`
    if (!(await exists(src))) {
      continue
    }

    partValues[partition] = await parseOverlayApksRecursive(aapt2Path, partition, src, pathCallback, filters)
  }

  return partValues
}

function shouldDeleteKey(filters: Filters, rawKey: string, { type, flags }: ResKey) {
  // Simple exclusion sets
  if (DIFF_EXCLUDE_TYPES.has(type)) {
    return true
  }

  // Exclude localized values for now
  if (flags != null) {
    return true
  }

  // User-provided filters
  if (!filterValue(filters, rawKey)) {
    return true
  }

  return false
}

function filterValues(keyFilters: Filters, valueFilters: Filters, values: ResValues) {
  for (let [rawKey, value] of values.entries()) {
    let key = decodeResKey(rawKey)

    if (shouldDeleteKey(keyFilters, rawKey, key) || (typeof value === 'string' && !filterValue(valueFilters, value))) {
      // Key/value filter
      values.delete(rawKey)
    } else if (DIFF_MAP_PACKAGES.has(key.targetPkg)) {
      // Package map
      let targetPkg = DIFF_MAP_PACKAGES.get(key.targetPkg)!
      let newKey = encodeResKey({
        ...key,
        targetPkg,
      })

      values.delete(rawKey)
      values.set(newKey, value)
    }
  }
}

export function diffPartOverlays(
  pvRef: PartResValues,
  pvNew: PartResValues,
  keyFilters: Filters,
  valueFilters: Filters,
) {
  let missingPartValues: PartResValues = {}
  for (let [partition, valuesNew] of Object.entries(pvNew)) {
    let valuesRef = pvRef[partition]
    let missingValues: ResValues = new Map<string, ResValue>()

    // Filter values first
    filterValues(keyFilters, valueFilters, valuesRef)
    filterValues(keyFilters, valueFilters, valuesNew)

    // Find missing overlays
    for (let [key, refValue] of valuesRef.entries()) {
      if (!valuesNew.has(key)) {
        missingValues.set(key, refValue)
      }
    }

    if (missingValues.size > 0) {
      missingPartValues[partition] = missingValues
    }
  }

  return missingPartValues
}

function serializeXmlObject(obj: unknown) {
  return XML_HEADER + XML_BUILDER.buildObject(obj).replace(/^<\?xml.*>$/m, '')
}

export async function serializePartOverlays(partValues: PartResValues, overlaysDir: string) {
  let buildPkgs = []
  for (let [partition, values] of Object.entries(partValues)) {
    // Group by package and target name
    let pkgValues = new Map<string, Map<ResKey, ResValue>>()
    for (let [key, value] of values.entries()) {
      let keyInfo = decodeResKey(key)
      let pkgNameKey = `${keyInfo.targetPkg}${keyInfo.targetName?.length ? `/${keyInfo.targetName}` : ''}`

      if (pkgValues.has(pkgNameKey)) {
        pkgValues.get(pkgNameKey)!.set(keyInfo, value)
      } else {
        pkgValues.set(pkgNameKey, new Map<ResKey, ResValue>([[keyInfo, value]]))
      }
    }

    // Now serialize each (package,target)-partition combination
    for (let [pkgNameKey, values] of pkgValues.entries()) {
      let [targetPkg, targetName] = pkgNameKey.split('/')
      let genTarget = pkgNameKey.replace('/', '__')
      let rroName = `${genTarget}.auto_generated_rro_${partition}_adevtool__`

      let bp = serializeBlueprint({
        modules: [
          {
            _type: 'runtime_resource_overlay',
            name: rroName,

            ...(partition == 'system_ext' && { system_ext_specific: true }),
            ...(partition == 'product' && { product_specific: true }),
            ...(partition == 'vendor' && { soc_specific: true }),
            ...(partition == 'odm' && { device_specific: true }),
          },
        ],
      })

      let manifest = serializeXmlObject({
        manifest: {
          $: {
            'xmlns:android': 'http://schemas.android.com/apk/res/android',
            package: rroName,
          },
          overlay: [
            {
              $: {
                'android:targetPackage': targetPkg,
                'android:targetName': targetName,
                'android:isStatic': 'true',
                'android:priority': '1',
              },
            },
          ],
          application: [{ $: { 'android:hasCode': 'false' } }],
        },
      })

      let valuesObj = { resources: {} as { [type: string]: Array<unknown> } }
      let resEntries = Array.from(values.entries())
      resEntries.sort(([k1], [k2]) => {
        return k1.key.localeCompare(k2.key)
      })
      for (let [{ type, key }, value] of resEntries) {
        let entry = {
          $: {
            name: key,
          },
        } as { [key: string]: unknown }

        if (type.includes('array')) {
          entry.item = (value as Array<ResValue>).map(v => v.toString())
        } else {
          entry._ = value.toString()
        }

        // eslint-disable-next-line no-prototype-builtins
        if (valuesObj.resources.hasOwnProperty(type)) {
          valuesObj.resources[type].push(entry)
        } else {
          valuesObj.resources[type] = [entry]
        }
      }

      let valuesXml = serializeXmlObject(valuesObj)

      // Write files
      let overlayDir = `${overlaysDir}/${partition}_${genTarget}`
      let resDir = `${overlayDir}/res/values`
      await fs.mkdir(resDir, { recursive: true })
      let writes = [
        fs.writeFile(`${overlayDir}/Android.bp`, bp),
        fs.writeFile(`${overlayDir}/AndroidManifest.xml`, manifest),
        fs.writeFile(`${resDir}/values.xml`, valuesXml),
      ]
      await Promise.all(writes)

      buildPkgs.push(rroName)
    }
  }

  return buildPkgs
}

async function loadApkResValues(aapt2Path: string, partition: string, apkPath: string, tmpDir: string) {
  let protoApk = path.join(tmpDir, partition + '_' + path.basename(apkPath, '.apk') + '.proto.apk')
  // convert resource table and XMLs from binary to proto format
  await spawnAsyncNoOut(
    aapt2Path,
    [
      'convert',
      '--for-adevtool',
      '--output-format',
      'proto',
      apkPath,
      '-v', // verbose logging
      '-o',
      protoApk,
    ],
    line => (line.startsWith('note: writing ') && line.endsWith('to archive.')) || line.length == 0,
  )

  let reader = new NodeFileReader(protoApk)
  try {
    let { entries: zipEntries } = await unzip(reader)

    let manifest = XmlNode.decode(await zipEntryAsUint8Array(zipEntries['AndroidManifest.xml']))

    let overlayNode = manifest.element!.child.find(c => c.element?.name === 'overlay')!

    let namespaceUri = 'http://schemas.android.com/apk/res/android'

    let overlayAttrs = new Map<string, XmlAttribute>()

    for (let a of overlayNode.element!.attribute) {
      if (a.namespaceUri === namespaceUri) {
        overlayAttrs.set(a.name, a)
      }
    }

    if (overlayAttrs.has('category')) {
      // comment from original impl:
      // Overlays that have categories are user-controlled, so they're not relevant here
      return null
    }

    if (overlayAttrs.has('requiredSystemPropertyName')) {
      // comment from original impl:
      // Prop-guarded overlays are almost always in AOSP already, so don't bother checking them
      return null
    }

    let targetPkgAttr = overlayAttrs.get('targetPackage')
    assert(targetPkgAttr !== undefined, 'missing targetPkg overlay attribute for ' + apkPath)
    let targetNameAttr = overlayAttrs.get('targetName')

    let targetPkg = targetPkgAttr.value
    let targetName = targetNameAttr?.value ?? null

    let resourceTable = ResourceTable.decode(await zipEntryAsUint8Array(zipEntries['resources.pb']))

    return resourseTableToResValues(resourceTable, targetPkg, targetName)
  } finally {
    reader.close()
    await fs.rm(protoApk)
  }
}

function resourseTableToResValues(resTable: ResourceTable, targetPkg: string, targetName: string | null): ResValues {
  let values: ResValues = new Map<string, ResValue>()

  for (let pkg of resTable.package) {
    for (let resType of pkg.type) {
      for (let resEntry of resType.entry) {
        for (let resConfigValue of resEntry.configValue) {
          let resConfig = resConfigValue.config!
          let val = resConfigValue.value!

          let resItem = val.item
          if (resItem !== undefined) {
            let rv = protoResItemToResValue(resItem)
            if (rv !== null) {
              let resKey = toResKey(targetPkg, targetName, resType.name, resEntry.name, resConfigStr(resConfig))
              values.set(resKey, rv)
            }
          } else {
            let cv = val.compoundValue!
            if (cv.array) {
              let items = cv.array.element.map(e => protoResItemToResValue(e.item!))

              // check that all array entries are of supported type
              if (items.find(i => i === null) === undefined) {
                let typeName = 'array'
                let firstItem = cv.array!.element[0]?.item
                if (firstItem?.str !== undefined) {
                  typeName = 'string-array'
                } else if (
                  firstItem?.prim?.intHexadecimalValue !== undefined ||
                  firstItem?.prim?.intDecimalValue !== undefined
                ) {
                  typeName = 'integer-array'
                }
                let resKey = toResKey(targetPkg, targetName, typeName, resEntry.name, resConfigStr(resConfig))
                values.set(resKey, items as ResValue[])
              }
            }
            // TODO add support for more CompoundValue types
          }
        }
      }
    }
  }
  return values
}

function protoResItemToResValue(item: Item): ResValue | null {
  if (item.str !== undefined) {
    let v = item.str.value
    return {
      toString() {
        // rest of special characters are handled by XML encoder
        if (v.match(/([@?\n\t'"\\])/)) {
          return '"' + v.replace('\\', '\\\\').replace('"', '\\"') + '"'
        } else {
          return v
        }
      },
    } as ResValue
  } else if (item.prim) {
    let p = item.prim
    if (p.booleanValue !== undefined) {
      return p.booleanValue
    }
    if (p.intDecimalValue !== undefined) {
      return p.intDecimalValue
    }
    if (p.intHexadecimalValue !== undefined) {
      return p.intHexadecimalValue
    }
    if (p.floatValue !== undefined) {
      return roundFloat(p.floatValue)
    }
    if (p.emptyValue !== undefined) {
      return ''
    }
    if (p.fractionValue !== undefined) {
      return new Complex(ComplexType.TYPE_FRACTION, p.fractionValue).asString()
    }
    if (p.dimensionValue !== undefined) {
      return new Complex(ComplexType.TYPE_DIMENSION, p.dimensionValue).asString()
    }
    if (p.colorArgb4Value !== undefined) {
      return '#' + p.colorArgb4Value.toString(16)
    }
    if (p.colorArgb8Value !== undefined) {
      return '#' + p.colorArgb8Value.toString(16)
    }
    if (p.colorRgb4Value !== undefined) {
      return '#' + p.colorRgb4Value.toString(16)
    }
    if (p.colorRgb8Value !== undefined) {
      return '#' + p.colorRgb8Value.toString(16)
    }
    if (p.nullValue !== undefined) {
      return ''
    }
  } else if (item.ref) {
    let ref = item.ref
    if (ref.type === Reference_Type.REFERENCE && ref.id === 0 && ref.name === '' && !ref.isDynamic) {
      return {
        toString(): string {
          return '@null'
        },
      } as ResValue
    }
  }
  // TODO add support for more types

  return null
}

async function zipEntryAsUint8Array(e: ZipEntry) {
  return new Uint8Array(await e.arrayBuffer())
}

enum ComplexType {
  TYPE_DIMENSION,
  TYPE_FRACTION,
}

// configuration values joined by dashes, same format as in values- Android resource dirs (e.g. en-sw600dp-night)
function resConfigStr(c: Configuration) {
  let v = c.stringified!
  if (v === '') {
    return null
  }
  return v
}

function roundFloat(v: number) {
  return parseFloat(
    v.toLocaleString(undefined, {
      useGrouping: false,
      minimumFractionDigits: 0,
      maximumFractionDigits: 5,
    }),
  )
}

// ported to TypeScript from frameworks/base/core/java/android/util/TypedValue.java
class Complex {
  unit: number

  constructor(
    readonly type: ComplexType,
    readonly raw: number,
  ) {
    this.unit = (raw >> COMPLEX_UNIT_SHIFT) & COMPLEX_UNIT_MASK
  }

  asFloat() {
    return (
      (this.raw & (COMPLEX_MANTISSA_MASK << COMPLEX_MANTISSA_SHIFT)) *
      RADIX_MULTS[(this.raw >> COMPLEX_RADIX_SHIFT) & COMPLEX_RADIX_MASK]
    )
  }

  asString() {
    let fv = this.asFloat()
    let f = roundFloat(fv).toString()
    switch (this.type) {
      case ComplexType.TYPE_DIMENSION: {
        switch (this.unit) {
          case COMPLEX_UNIT_PX:
            return f + 'px'
          case COMPLEX_UNIT_DIP:
            return f + 'dp'
          case COMPLEX_UNIT_SP:
            return f + 'sp'
          case COMPLEX_UNIT_PT:
            return f + 'pt'
          case COMPLEX_UNIT_IN:
            return f + 'in'
          case COMPLEX_UNIT_MM:
            return f + 'mm'
        }
        throw new Error('unknown unit ' + this.unit)
      }
      case ComplexType.TYPE_FRACTION: {
        switch (this.unit) {
          case COMPLEX_UNIT_FRACTION:
            return roundFloat(fv * 100.0) + '%'
          case COMPLEX_UNIT_FRACTION_PARENT:
            return roundFloat(fv * 100.0) + '%p'
        }
        throw new Error('unknown unit ' + this.unit)
      }
    }
    return null
  }
}

/** {@link #TYPE_DIMENSION} complex unit: Value is raw pixels. */
const COMPLEX_UNIT_PX = 0
/** {@link #TYPE_DIMENSION} complex unit: Value is Device Independent
 *  Pixels. */
const COMPLEX_UNIT_DIP = 1
/** {@link #TYPE_DIMENSION} complex unit: Value is a scaled pixel. */
const COMPLEX_UNIT_SP = 2
/** {@link #TYPE_DIMENSION} complex unit: Value is in points. */
const COMPLEX_UNIT_PT = 3
/** {@link #TYPE_DIMENSION} complex unit: Value is in inches. */
const COMPLEX_UNIT_IN = 4
/** {@link #TYPE_DIMENSION} complex unit: Value is in millimeters. */
const COMPLEX_UNIT_MM = 5

/** {@link #TYPE_FRACTION} complex unit: A basic fraction of the overall
 *  size. */
const COMPLEX_UNIT_FRACTION = 0
/** {@link #TYPE_FRACTION} complex unit: A fraction of the parent size. */
const COMPLEX_UNIT_FRACTION_PARENT = 1

/** Complex data: where the radix information is, telling where the decimal
 *  place appears in the mantissa. */
const COMPLEX_RADIX_SHIFT = 4
/** Complex data: mask to extract radix information (after shifting by
 * {@link #COMPLEX_RADIX_SHIFT}). This give us 4 possible fixed point
 * representations as defined below. */
const COMPLEX_RADIX_MASK = 0x3

/** Complex data: bit location of mantissa information. */
const COMPLEX_MANTISSA_SHIFT = 8
/** Complex data: mask to extract mantissa information (after shifting by
 *  {@link #COMPLEX_MANTISSA_SHIFT}). This gives us 23 bits of precision
 *  the top bit is the sign. */
const COMPLEX_MANTISSA_MASK = 0xffffff

const MANTISSA_MULT = 1.0 / (1 << COMPLEX_MANTISSA_SHIFT)
const RADIX_MULTS = [
  1.0 * MANTISSA_MULT,
  (1.0 / (1 << 7)) * MANTISSA_MULT,
  (1.0 / (1 << 15)) * MANTISSA_MULT,
  (1.0 / (1 << 23)) * MANTISSA_MULT,
]

/** Complex data: bit location of unit information. */
const COMPLEX_UNIT_SHIFT = 0
/** Complex data: mask to extract unit information (after shifting by
 *  {@link #COMPLEX_UNIT_SHIFT}). This gives us 16 possible types, as
 *  defined below. */
const COMPLEX_UNIT_MASK = 0xf
