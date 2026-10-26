import { Command, Flags } from '@oclif/core'
import assert from 'assert'
import { promises as fs } from 'fs'
import path from 'path'
import xml2js from 'xml2js'
import YAML from 'yaml'
import { OS_CHECKOUT_DIR } from '../config/paths'
import { assertDefined, assertNonNull } from '../util/data'
import { readFile } from '../util/fs'
import { log } from '../util/log'
import { spawnAsync, spawnAsyncNoOut } from '../util/process'

export interface Remote {
  name: string
  fetch: string
}

export interface Project {
  path: string
  name: string
  groups?: string
  clone_depth?: string
  remote?: string
}

export interface ManifestConfig {
  aosp_revision: string
  revision: string
  additional_remotes: Remote[]
  additional_projects: Project[]
  additional_non_manifest_repos: string[]
  forked_aosp_repos: { [remoteName: string]: string[] }
  clone_depth_1_aosp_repos: string[]
  removed_aosp_repos: string
}

interface XmlElement {
  $: Record<string, string>
}

export class GenerateManifest extends Command {
  static flags = {
    config: Flags.file({ default: path.join(OS_CHECKOUT_DIR, '.repo/manifests/config.yml') }),
    addFork: Flags.string({ multiple: true }),
    delFork: Flags.string({ multiple: true }),
    // must be set when addFork/delFork are used
    forkRemote: Flags.string(),
    out: Flags.file({ default: path.join(OS_CHECKOUT_DIR, '.repo/manifests/default.xml') }),
    skipScriptUpdate: Flags.boolean({ description: "don't rewrite script/common.sh" }),
  }

  async run() {
    let { flags } = await this.parse(GenerateManifest)

    let config = await parseConfig(flags.config)

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

    let cloneDepth1AospRepos = new Set(config.clone_depth_1_aosp_repos)

    let delForks = flags.delFork ?? []
    let addForks = flags.addFork ?? []

    for (;;) {
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
        projects = projects.filter(p => !removedAospRepos.has(p.$.name))
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

      let addingFork: string | null = null
      let deletingFork: string | null = null
      if (delForks.length > 0) {
        deletingFork = assertDefined(delForks.shift())
      } else if (addForks.length > 0) {
        addingFork = assertDefined(addForks.shift())
      }

      if (addingFork !== null || deletingFork !== null) {
        let remoteName = assertDefined(flags.forkRemote)
        let forkedRepos = new Set(assertDefined(config.forked_aosp_repos[remoteName]))

        let allRepos = new Set<string>()
        for (let proj of projects) {
          allRepos.add(proj.$.name)
        }

        if (addingFork !== null) {
          if (!allRepos.has(addingFork)) {
            log('skipping unknown repo ' + addingFork)
            continue
          }
          if (forkedRepos.has(addingFork)) {
            log(addingFork + ' is already forked')
            addingFork = null
          } else {
            forkedRepos.add(addingFork)
          }
        } else {
          deletingFork = assertNonNull(deletingFork)
          if (forkedRepos.has(deletingFork)) {
            forkedRepos.delete(deletingFork)
          } else {
            log(deletingFork + ' is not currently forked')
            deletingFork = null
          }
        }
        let collator = new Intl.Collator(undefined, { caseFirst: 'false' })
        config.forked_aosp_repos[remoteName] = Array.from(forkedRepos).sort((a, b) => collator.compare(a, b))

        await fs.writeFile(flags.config, YAML.stringify(config))

        config = await parseConfig(flags.config)
      }

      let forkedAospRepos = makeAospForkMap(config)
      let forks: string[] = []
      for (let proj of projects) {
        let name = proj.$.name
        if (cloneDepth1AospRepos.has(name)) {
          proj.$['clone-depth'] = '1'
        }
        let forkRemoteName = forkedAospRepos.get(name)
        if (forkRemoteName !== undefined) {
          let forkName = makeForkName(name)
          proj.$.name = forkName
          forks.push(forkName)
          proj.$.remote = forkRemoteName
          proj.$['aosp-name'] = name
        }
      }

      manifest.manifest.project = projects

      if (!flags.skipScriptUpdate) {
        await updateScript(config, forks)

        if (addingFork !== null || deletingFork !== null) {
          let gitRepoDir = path.join(OS_CHECKOUT_DIR, SCRIPT_REPO_PATH)
          await spawnAsyncNoOut('git', ['-C', gitRepoDir, 'add', COMMON_SH_NAME])
          let commitMsg = `${addingFork !== null ? 'add' : 'delete'} ${makeForkName(addingFork ? addingFork : assertNonNull(deletingFork))}`
          log(gitRepoDir)
          log(await spawnAsync('git', ['-C', gitRepoDir, 'commit', '-m', commitMsg]))
        }
      }

      let xmlStr = new xml2js.Builder({ headless: true }).buildObject(manifest)
      xmlStr =
        `<?xml version="1.0" encoding="UTF-8"?>
<!-- This file was generated by adevtool. To update it, edit config.yml and run
\'adevtool generate-manifest\' from the root of OS checkout. -->\n` + xmlStr
      await fs.writeFile(flags.out, xmlStr + '\n')

      if (addingFork !== null || deletingFork !== null) {
        let gitRepoDir = path.dirname(flags.config)
        await spawnAsyncNoOut('git', ['-C', gitRepoDir, 'add', path.basename(flags.config), 'default.xml'])
        let commitMsg = `${addingFork !== null ? 'use fork of' : 'stop using fork of'} ${addingFork ? addingFork : assertNonNull(deletingFork)}`
        log(gitRepoDir)
        log(await spawnAsync('git', ['-C', gitRepoDir, 'commit', '-m', commitMsg]))
      }

      if (addForks.length === 0 && delForks.length === 0) {
        break
      }
    }
  }
}

const SCRIPT_REPO_PATH = 'script'
const COMMON_SH_NAME = 'common.sh'

async function updateScript(config: ManifestConfig, forks: string[]) {
  let dstFilePath = path.join(OS_CHECKOUT_DIR, SCRIPT_REPO_PATH, COMMON_SH_NAME)
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

export function makeAospForkMap(config: ManifestConfig) {
  let res = new Map<string, string>()
  for (let [remoteName, repos] of Object.entries(config.forked_aosp_repos)) {
    for (let repo of repos) {
      res.set(repo, remoteName)
    }
  }
  return res
}

function makeForkName(name: string) {
  return name.replaceAll('/', '_')
}

async function parseConfig(filePath: string) {
  return YAML.parse(await readFile(filePath)) as ManifestConfig
}
