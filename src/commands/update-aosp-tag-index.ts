import { Command, Flags } from '@oclif/core'
import assert from 'assert'
import { writeFileSync } from 'fs'
import YAML from 'yaml'

import { ADEVTOOL_DIR, BUILD_ID_TO_TAG_FILE } from '../config/paths'
import { showGitDiff } from '../util/cli'
import { readFile } from '../util/fs'
import { GitLsRemote } from '../util/git'
import { yamlStringifyNoFold } from '../util/yaml'

type BuildIdToTag = Map<string, string>

export async function loadBuildIdToTagMap(): Promise<BuildIdToTag | null> {
  try {
    let file = await readFile(BUILD_ID_TO_TAG_FILE)
    return YAML.parse(file, { mapAsMap: true }) as BuildIdToTag
  } catch {
    return null
  }
}

export default class UpdateAospTagIndex extends Command {
  static description = `update buildId-to-tag map in ${BUILD_ID_TO_TAG_FILE}`

  static flags = {
    dryRun: Flags.boolean({
      char: 'n',
      description: 'skip file update',
    }),
  }

  async run() {
    let { flags } = await this.parse(UpdateAospTagIndex)

    // let bases = ['android-vts', 'android-security', 'android', 'android-platform', 'android-cts']
    let bases = ['android']
    // let versions = ['11.0.0', '12.0.0', '12.1.0', '13.0.0']
    let versions = ['13.0.0', '14.0.0']

    let prefixes: string[] = []
    bases.forEach(base =>
      versions.forEach(version => {
        if (base === 'android-cts' || base === 'android-vts') {
          version = version.slice(0, -2)
        }
        prefixes.push(`${base}-${version}_r`)
      }),
    )

    let map = (await loadBuildIdToTagMap()) ?? new Map<string, string>()
    let lsRemote = await GitLsRemote.get('https://github.com/aosp-mirror/platform_build')

    let knownTags = new Set(map.values())
    let requests = new Map<string, Promise<Response>>()

    for (let tagName of lsRemote.tags.keys()) {
      if (knownTags.has(tagName)) {
        continue
      }

      if (prefixes.find(p => tagName.startsWith(p)) === undefined) {
        continue
      }

      let url = `https://raw.githubusercontent.com/aosp-mirror/platform_build/${tagName}/core/build_id.mk`
      requests.set(tagName, fetch(url))
    }

    let numNewTags = 0

    for (let [tagName, responsePromise] of requests.entries()) {
      let resp = await responsePromise
      assert(resp.ok, tagName)

      let build_id_mk = await resp.text()
      let buildIdPrefix = 'BUILD_ID='
      let line = build_id_mk.split('\n').find(s => s.startsWith(buildIdPrefix))
      assert(line !== undefined, 'missing BUILD_ID line in:\n' + build_id_mk)
      let build_id = line.substring(buildIdPrefix.length).trim()

      this.log(tagName + ': ' + build_id)
      map.set(build_id, tagName)
      ++numNewTags
    }

    if (!flags.dryRun && numNewTags > 0) {
      let entries = Array.from(map.entries()).sort(([, tag1], [, tag2]) => compareTags(tag1, tag2))

      writeFileSync(BUILD_ID_TO_TAG_FILE, yamlStringifyNoFold(new Map(entries)))
    }

    if (numNewTags === 0) {
      this.log('No new tags')
      process.exit(1)
    }

    showGitDiff(ADEVTOOL_DIR, BUILD_ID_TO_TAG_FILE)
  }
}

function getTagRevision(tag: string) {
  let idx = tag.lastIndexOf('_r')
  assert(idx > 0, tag)
  return parseInt(tag.substring(idx + 2))
}

function getTagBase(tag: string) {
  let idx = tag.lastIndexOf('_r')
  assert(idx > 0, tag)
  return tag.slice(0, idx)
}

function compareTags(a: string, b: string) {
  let res = getTagBase(a).localeCompare(getTagBase(b))
  if (res == 0) {
    res = getTagRevision(a) - getTagRevision(b)
  }
  return res
}
