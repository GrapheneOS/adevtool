import assert from 'assert'
import { JSDOM } from 'jsdom'
import fetch from 'node-fetch'
import path from 'path'
import YAML from 'yaml'
import { YAMLMap } from 'yaml/types'

import { loadAndMergeConfig } from '../config/config-loader'
import { DeviceBuildId, DeviceConfig, makeDeviceBuildId } from '../config/device'
import { BUILD_INDEX_FILE } from '../config/paths'

export type BuildIndex = Map<DeviceBuildId, BuildProps>
export type BuildProps = Map<string, string>

export enum ImageType {
  Ota = 'ota',
  Factory = 'factory',
}

const BUILD_PROP_DESCRIPTION = 'desc'
const BUILD_PROP_FACTORY_IMAGE = ImageType.Factory as string
const BUILD_PROP_OTA_IMAGE = ImageType.Ota as string
// vendor image build props have 'vendor/$VENDOR_NAME' name

// enums don't allow non-literal values, use plain constants instead
const PAGE_TYPE_FACTORY = BUILD_PROP_FACTORY_IMAGE
const PAGE_TYPE_OTA = BUILD_PROP_OTA_IMAGE
const PAGE_TYPE_VENDOR = 'vendor'

const BETA_VERSION_BASE_URL = 'https://developer.android.com/about/versions'

export const DEFAULT_BASE_DOWNLOAD_URL = 'https://dl.google.com/dl/android/aosp/'

interface PageTypeInfo {
  mainUrl: string
  betaUrlSuffix: string | null
  betaNameSeparator: string | null
}

const BASE_URL = 'https://developers.google.com/android'

const PAGE_TYPES: Record<string, PageTypeInfo> = {
  [PAGE_TYPE_FACTORY]: {
    mainUrl: BASE_URL + '/images',
    betaUrlSuffix: 'download',
    betaNameSeparator: '_beta-',
  },
  [PAGE_TYPE_OTA]: {
    mainUrl: BASE_URL + '/ota',
    betaUrlSuffix: 'download-ota',
    betaNameSeparator: '_beta-ota-',
  },
  [PAGE_TYPE_VENDOR]: {
    mainUrl: BASE_URL + '/drivers',
    betaUrlSuffix: null,
    betaNameSeparator: null,
  },
}

export async function loadBuildIndex(filePath: string = BUILD_INDEX_FILE): Promise<BuildIndex> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let obj: any = await loadAndMergeConfig(filePath, {})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let outerMap = new Map<string, any>(Object.entries(obj))
  for (let k of outerMap.keys()) {
    outerMap.set(k, new Map<string, string>(Object.entries(outerMap.get(k))))
  }
  return outerMap as BuildIndex
}

export async function fetchBuildIndex(deviceConfigs: DeviceConfig[]): Promise<YAMLMap> {
  return fetchBuildIndexInner(deviceConfigs)
}

export async function fetchBetaBuildIndex(devices: DeviceConfig[], version: string): Promise<YAMLMap> {
  return fetchBuildIndexInner(devices, version)
}

async function fetchBuildIndexInner(
  deviceConfigs: DeviceConfig[],
  betaVersion: string | null = null,
): Promise<YAMLMap> {
  let buildIndex: BuildIndex = new Map<DeviceBuildId, BuildProps>()
  let devices = new Set(deviceConfigs.map(d => d.device.name))

  // parallelize page fetching
  let pageHtmlMap = new Map<string, Promise<string>>()

  for (let type in PAGE_TYPES) {
    let typeInfo = PAGE_TYPES[type]
    if (betaVersion !== null && type === PAGE_TYPE_VENDOR) {
      // no vendor images for beta builds
      continue
    }
    pageHtmlMap.set(type, fetchPageHtml(typeInfo, betaVersion))
  }

  for (let [type, pageHtmlPromise] of pageHtmlMap) {
    let dom = new JSDOM(await pageHtmlPromise)

    if (betaVersion === null) {
      if (type !== PAGE_TYPE_VENDOR) {
        parseFactoryOrOtaPage(buildIndex, type, dom, devices)
      } else {
        parseVendorPage(buildIndex, dom, devices)
      }
    } else {
      parseBetaFactoryOrOtaPage(buildIndex, type, PAGE_TYPES[type], dom, devices)
    }
  }

  return YAML.createNode(buildIndex) as YAMLMap
}

function parseFactoryOrOtaPage(buildIndex: BuildIndex, pageType: string, dom: JSDOM, devices: Set<string>) {
  for (let device of devices) {
    let header = dom.window.document.querySelector(`#${device}`) as HTMLHeadingElement
    let table = header.nextElementSibling! as HTMLTableElement

    for (let i = 1; i < table.rows.length; ++i) {
      let row = table.rows[i]

      let version = row.cells[0].textContent!
      assert(version.endsWith(')'), 'unexpected version string: ' + version)

      let buildIdAndDescription = version.slice(version.indexOf(' (') + 2, -1)
      let buildId = row.id.substring(device.length).toUpperCase()

      let description = buildIdAndDescription.substring(buildId.length + 2)

      let buildProps = getBuildProps(buildIndex, device, buildId)
      if (!buildProps.has(BUILD_PROP_DESCRIPTION)) {
        buildProps.set(BUILD_PROP_DESCRIPTION, description)
      }

      parseFactoryOrOtaRow(row, pageType, device, buildId, buildProps)
    }
  }
}

function parseVendorPage(buildIndex: BuildIndex, dom: JSDOM, devices: Set<string>) {
  for (let device of devices) {
    let header = dom.window.document.querySelector(`#${device}`) as HTMLHeadingElement
    let head = header.nextElementSibling!

    while (head.id.startsWith(device)) {
      let buildId = head.id.substring(device.length).toUpperCase()
      let table = head.nextElementSibling!.firstElementChild as HTMLTableElement
      let buildProps = getBuildProps(buildIndex, device, buildId)
      parseVendorTable(table, device, buildId, buildProps)
      head = head.nextElementSibling!.nextElementSibling!
    }
  }
}

function parseBetaFactoryOrOtaPage(
  buildIndex: BuildIndex,
  pageType: string,
  typeInfo: PageTypeInfo,
  dom: JSDOM,
  devices: Set<string>,
) {
  let doc: Document = dom.window.document
  let table = doc.querySelector('#images > tbody') as HTMLTableElement

  let rows = table.rows

  // first row contains row names
  for (let i = 1; i < rows.length; ++i) {
    let row = rows[i]
    // Columns: Device | Download Link <newline> SHA-256 Checksum

    let fileNameAndHash = row.cells[1].textContent!.split('\n')
    assert(fileNameAndHash.length == 3, `unexpected fileNameAndHash value ${fileNameAndHash}`)
    assert(fileNameAndHash[0] === '', `${fileNameAndHash}`)

    let fileName = fileNameAndHash[1].trim()
    assert(fileName.endsWith('.zip'), `unexpected extension of filename ${fileName}`)

    let spr = typeInfo.betaNameSeparator!
    let sprIdx = fileName.indexOf(spr)
    assert(sprIdx >= 1, `missing separator ${spr} in filename ${fileName}`)

    let device = fileName.substring(0, sprIdx)
    if (!devices.has(device)) {
      continue
    }

    let buildIdStart = sprIdx + spr.length
    let buildIdEnd = fileName.indexOf('-', buildIdStart)
    assert(buildIdEnd > buildIdStart, fileName)
    let buildId = fileName.substring(buildIdStart, buildIdEnd).toUpperCase()

    let dlButton = doc.getElementById(`agree-button__${device}_${pageType}_zip`) as HTMLAnchorElement
    let dlLink = dlButton.href
    assert(path.basename(dlLink) === fileName, dlLink)

    let sha256 = fileNameAndHash[2].trim()
    assert(sha256.length == 64, `unexpected SHA-256 lenght: ${sha256}`)

    let buildProps = getBuildProps(buildIndex, device, buildId)
    addImageToBuildProps(pageType, dlLink, sha256, buildProps)
  }
}

async function fetchPageHtml(pageType: PageTypeInfo, betaVersion: string | null = null) {
  let url: string
  if (betaVersion === null) {
    url = pageType.mainUrl
  } else {
    let suffix = pageType.betaUrlSuffix!
    url = `${BETA_VERSION_BASE_URL}/${betaVersion}/${suffix}`
  }

  const cookie = 'devsite_wall_acks=nexus-image-tos,nexus-ota-tos'
  let resp = await fetch(url, { headers: { Cookie: cookie } })
  assert(resp.ok)
  return await resp.text()
}

function getBuildProps(buildIndex: BuildIndex, device: string, buildId: string): BuildProps {
  let key: DeviceBuildId = makeDeviceBuildId(device, buildId)
  let res = buildIndex.get(key)
  if (res === undefined) {
    res = new Map<string, string>() as BuildProps
    buildIndex.set(key, res)
  }
  return res
}

// if fileNameOrUrl is a filename (detected by lack of '/'), it's joined to the DEFAULT_BASE_DOWNLOAD_URL when parsing
function addImageToBuildProps(key: string, fileNameOrUrl: string, checksum: string, dst: BuildProps) {
  // keep in sync with DeviceImage.get()
  dst.set(key, checksum + ' ' + fileNameOrUrl)
}

function parseVendorTable(table: HTMLTableElement, dev: string, release: string, dest: BuildProps) {
  let rows = table.rows
  // first row contains column names, skip it
  for (let i = 1; i < rows.length; ++i) {
    let cells = rows[i].cells
    // Columns: Hardware Component | Company | Download | SHA-256 Checksum
    let link = getLinkHref(cells[2])
    let filename = path.basename(link)
    assert(filename.match(`.+-${dev}-${release.toLowerCase()}-.+\\.tgz$`))

    let vendorName = filename.substring(0, filename.indexOf('-'))

    addImageToBuildProps(`vendor/${vendorName}`, filename, parseSha256(cells[3]), dest)
  }
}

function parseFactoryOrOtaRow(
  row: HTMLTableRowElement,
  pageType: string,
  dev: string,
  buildId: string,
  buildProps: BuildProps,
) {
  let cells = row.cells

  let linkIdx: number
  let shaIdx: number
  let namePrefix: string
  if (pageType === PAGE_TYPE_FACTORY) {
    linkIdx = 2
    shaIdx = 3
    namePrefix = `${dev}-${buildId.toLowerCase()}-${pageType}-`
  } else {
    assert(pageType === PAGE_TYPE_OTA)
    // Columns: Version | Download | SHA-256 Checksum
    linkIdx = 1
    shaIdx = 2
    namePrefix = `${dev}-${pageType}-${buildId.toLowerCase()}-`
  }

  let href = getLinkHref(cells[linkIdx])
  let filename = path.basename(href)

  assert(filename.match(`^${namePrefix}.+\\.zip$`))
  assert(DEFAULT_BASE_DOWNLOAD_URL + filename === href, 'Unexpected image download link ' + href)

  addImageToBuildProps(pageType, filename, parseSha256(cells[shaIdx]), buildProps)
}

function parseSha256(cell: HTMLTableCellElement) {
  let s = cell.textContent!
  if (s.endsWith('.zip')) {
    s = s.slice(0, -'.zip'.length)
  }
  assert(s.length === 64, s)
  return s
}

function getLinkHref(cell: HTMLTableCellElement) {
  assert(cell.textContent === 'Link')
  assert(cell.childNodes.length === 1)
  return (cell.firstChild as HTMLAnchorElement).href
}
