import { Command, Flags } from '@oclif/core'
import assert from 'assert'
import { promises as fs } from 'fs'
import path from 'path'
import xml2js from 'xml2js'
import YAML from 'yaml'
import { OS_CHECKOUT_DIR } from '../config/paths'
import { readFile } from '../util/fs'
import { spawnAsync } from '../util/process'

interface Remote {
  name: string
  fetch: string
}

interface Project {
  path: string
  name: string
  groups?: string
  clone_depth?: string
  remote?: string
}

interface ManifestConfig {
  aosp_revision: string
  revision: string
  additional_remotes: Remote[]
  additional_projects: Project[]
  additional_non_manifest_repos: string[]
  forked_aosp_repos: string[]
  clone_depth_1_aosp_repos: string[]
  removed_aosp_repos: string
}

interface XmlElement {
  $: Record<string, string>
}

export class GenerateManifest extends Command {
  static flags = {
    config: Flags.file({ default: path.join(OS_CHECKOUT_DIR, '.repo/manifests/config.yml') }),
    // TODO
    // addFork: Flags.string({ multiple: true }),
    // delFork: Flags.string({ multiple: true }),
    out: Flags.file({ default: path.join(OS_CHECKOUT_DIR, '.repo/manifests/default.xml') }),
    skipScriptUpdate: Flags.boolean({ description: "don't rewrite script/common.sh" }),
  }

  async run() {
    let { flags } = await this.parse(GenerateManifest)

    let config = YAML.parse(await readFile(flags.config)) as ManifestConfig

    let tmpDir = await fs.mkdtemp('aosp-manifest')
    let manifestStr: string
    try {
      let out = await spawnAsync('git', [
        '-C',
        tmpDir,
        'clone',
        '--branch', // accepts tags as well
        config.aosp_revision,
        '--depth=1',
        '--quiet',
        'https://android.googlesource.com/platform/manifest',
      ])
      assert(out.length === 0)
      manifestStr = await readFile(path.join(tmpDir, 'manifest/default.xml'))
    } finally {
      await fs.rm(tmpDir, { recursive: true })
    }

    let manifest = await xml2js.parseStringPromise(manifestStr)
    {
      let remotes = manifest.manifest.remote as XmlElement[]
      assert(remotes.length === 1)
      let aospRemote = remotes[0]
      assert(aospRemote.$.name === 'aosp')
      assert(aospRemote.$.fetch === '..')
      aospRemote.$.fetch = 'https://android.googlesource.com'
      manifest.manifest.remote = [
        ...config.additional_remotes.map(remote => {
          return { $: { ...remote, revision: config.revision } }
        }),
        aospRemote,
      ]
    }

    let projects = manifest.manifest.project as XmlElement[]
    {
      let removedAospRepos = new Set(config.removed_aosp_repos)
      projects = projects.filter(p => !removedAospRepos.has(p.$.path))
    }
    let cloneDepth1AospRepos = new Set(config.clone_depth_1_aosp_repos)
    let forkedAospRepos = new Set(config.forked_aosp_repos)
    let forks: string[] = []
    for (let proj of projects) {
      let path = proj.$.path
      if (cloneDepth1AospRepos.has(path)) {
        proj.$['clone-depth'] = '1'
      }
      if (forkedAospRepos.has(path)) {
        let name = proj.$.name
        let forkName = name.replaceAll('/', '_')
        proj.$.name = forkName
        forks.push(forkName)
        proj.$.remote = config.additional_remotes[0].name
        proj.$['aosp-name'] = name
      }
    }

    for (let proj of config.additional_projects) {
      let path = proj.path
      let name = proj.name
      let groups: string | undefined = proj.groups
      let remote = proj.remote !== undefined ? proj.remote : config.additional_remotes[0].name
      let obj = {
        $: {
          path,
          name,
          ...(groups !== undefined && { groups }),
          remote,
          ...(proj.clone_depth !== undefined && { 'clone-depth': proj.clone_depth }),
        },
      }
      projects.push(obj)
    }

    let collator = new Intl.Collator()
    projects.sort((a, b) => {
      return collator.compare(a.$.path, b.$.path)
    })
    manifest.manifest.project = projects

    if (!flags.skipScriptUpdate) {
      await updateScript(config, forks)
    }

    let xmlStr = new xml2js.Builder({
      xmldec: {
        version: '1.0',
        encoding: 'UTF-8',
      },
    }).buildObject(manifest)
    await fs.writeFile(flags.out, xmlStr)
  }
}

async function updateScript(config: ManifestConfig, forks: string[]) {
  let dstFilePath = path.join(OS_CHECKOUT_DIR, 'script/common.sh')
  let dstFile = await readFile(dstFilePath)
  let forksStartMarker = 'readonly aosp_forks=(\n'
  let forksStart = dstFile.indexOf(forksStartMarker)
  assert(forksStart >= 0)
  forksStart += forksStartMarker.length
  let forksEnd = dstFile.indexOf('\n)', forksStart)
  assert(forksEnd > forksStart)

  let indepStartMarker = 'readonly independent=(\n'
  let indepStart = dstFile.indexOf(indepStartMarker)
  assert(indepStart > forksEnd)
  indepStart += indepStartMarker.length
  let indepEnd = dstFile.indexOf('\n)', indepStart)
  assert(indepEnd > indepStart)

  let collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

  dstFile =
    dstFile.substring(0, forksStart) +
    forks
      .toSorted(collator.compare)
      .map(s => '    ' + s)
      .join('\n') +
    dstFile.substring(forksEnd, indepStart) +
    config.additional_projects
      .map(e => e.name)
      .concat(...config.additional_non_manifest_repos)
      .sort(collator.compare)
      .map(s => '    ' + s)
      .join('\n') +
    dstFile.substring(indepEnd)
  await fs.writeFile(dstFilePath, dstFile)
}
