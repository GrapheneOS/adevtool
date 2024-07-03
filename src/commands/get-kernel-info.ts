import { Command, Flags } from '@oclif/core'
import assert from 'assert'
import chalk from 'chalk'
import { existsSync, promises as fs } from 'fs'
import { JSDOM } from 'jsdom'
import path from 'path'
import { DEVICE_CONFIG_FLAGS, loadDeviceConfigs } from '../config/device'
import { DeviceImages, prepareFactoryImages } from '../frontend/source'

import { loadBuildIndex } from '../images/build-index'
import { DeviceImage } from '../images/device-image'
import { maybePlural } from '../util/cli'
import { updateMultiMap } from '../util/data'
import { GitLsRemote } from '../util/git'
import { spawnAsync } from '../util/process'

export default class GetKernelInfo extends Command {
  static description = 'get info about stock OS kernel: version, tag, branch, etc'

  static flags = {
    buildIds: Flags.string({
      char: 'b',
      multiple: true,
      default: ['cur'],
    }),
    ...DEVICE_CONFIG_FLAGS,
  }

  async run() {
    let { flags } = await this.parse(GetKernelInfo)
    let devices = await loadDeviceConfigs(flags.devices)
    let res = await prepareFactoryImages(await loadBuildIndex(), devices, flags.buildIds)

    let commitMap = new Map<string, DeviceImages[]>()
    let commitVersionMap = new Map<string, string>()

    let kernelRepoLsRemote = new Map<string, Promise<GitLsRemote>>()

    let kernelInfos: [Promise<KernelInfo>, DeviceImages][] = []

    for (let deviceImages of res.values()) {
      let kernelRepoUrl = deviceImages.factoryImage.deviceConfig.device.kernel_repo_url
      if (!kernelRepoLsRemote.has(kernelRepoUrl)) {
        kernelRepoLsRemote.set(kernelRepoUrl, GitLsRemote.get(kernelRepoUrl))
      }

      let dirs = ['vendor_dlkm/lib/modules', 'vendor/lib/modules']
      for (let dir of dirs) {
        let dirPath = path.join(deviceImages.unpackedFactoryImageDir, dir)
        if (!existsSync(dirPath)) {
          continue
        }

        const dirents = await fs.readdir(dirPath, { withFileTypes: true })

        let moduleFile = dirents.find(de => {
          return (
            de.name.endsWith('.ko') &&
            // has a different format of vermagic
            !de.name.startsWith('fips')
          )
        })!.name

        kernelInfos.push([getKernelInfoFromModule(path.join(dirPath, moduleFile)), deviceImages])
      }
    }

    for (let [kiPromise, imageSet] of kernelInfos) {
      let ki: KernelInfo = await kiPromise

      let cur = commitVersionMap.get(ki.commit)
      if (cur !== undefined) {
        assert(cur === ki.version, ki.commit)
      } else {
        commitVersionMap.set(ki.commit, ki.version)
      }

      updateMultiMap(commitMap, ki.commit, imageSet)
    }

    let commitInfos: Promise<CommitInfo>[] = []
    for (let [commit, deviceImages] of commitMap) {
      let factory = deviceImages[0].factoryImage
      let kernelRepoUrl = factory.deviceConfig.device.kernel_repo_url
      commitInfos.push(getCommitInfo(kernelRepoUrl, kernelRepoLsRemote, commit))
    }

    let logSeparator = false

    for (let i of await Promise.all(commitInfos)) {
      if (logSeparator) {
        this.log('=================================================================================\n')
      } else {
        logSeparator = true
      }
      let factory = commitMap.get(i.commit)!.map(i => i.factoryImage)
      this.log(
        chalk.bold(`${i.commit} (${commitVersionMap.get(i.commit)}): `) + getDeviceBuildIds(factory, flags.buildIds),
      )

      if (i.branches.length > 0) {
        this.log(`HEAD of branch${maybePlural(i.branches, '', 'es')}:\n${i.branches.join('\n')}`)
      }

      if (i.tags.length > 0) {
        this.log(`\nTag${maybePlural(i.tags)}:`)
      } else {
        this.log(`No tag for ${i.commit}`)
      }

      for (let tag of i.tags) {
        this.log(`${tag.name} | ${tag.annotation}\n${tag.date} | ${tag.author}\n`)
      }
    }
  }
}

interface CommitInfo {
  commit: string
  branches: string[]
  tags: TagInfo[]
}

interface TagInfo {
  name: string
  annotation: string
  date: string
  author: string
}

interface KernelInfo {
  version: string
  commit: string
}

async function getKernelInfoFromModule(modulePath: string) {
  let stdout = await spawnAsync('modinfo', ['--field=vermagic', modulePath])

  let parts = stdout.split('-')
  // console.log(parts)
  let version = parts[0]

  let commit: string
  if (parts[1].startsWith('android')) {
    commit = parts[3]
  } else {
    commit = parts[1]
  }
  assert(commit.length === 13)
  assert(commit[0] === 'g')
  commit = commit.substring(1)

  return { version, commit } as KernelInfo
}

async function getCommitInfo(repoUrl: string, lsRemoteMap: Map<string, Promise<GitLsRemote>>, commit: string) {
  let lsRemote = await lsRemoteMap.get(repoUrl)
  assert(lsRemote !== undefined)

  let tags = lsRemote.getTagsForCommit(commit)
  let branches = lsRemote.getBranchesForCommit(commit)

  let baseTagsUrl = repoUrl + '/+/refs/tags/'

  let tagInfos = await Promise.all(tags.map(name => loadTagInfo(baseTagsUrl + name, name)))

  return { commit, branches, tags: tagInfos } as CommitInfo
}

async function loadTagInfo(gitilesUrl: string, name: string) {
  let resp = await fetch(gitilesUrl)
  assert(resp.ok)

  // neither git ls-remote nor gitiles APIs support retrieving tag annotation, parse HTML

  let jsdom = new JSDOM(await resp.text())
  let doc = jsdom.window.document

  let tagAnnotation = doc.querySelector('body > div > div > pre:nth-child(3)') as HTMLPreElement
  assert(tagAnnotation.textContent!.endsWith('\n'))

  let annotation = tagAnnotation.textContent!.slice(0, -1)

  let tagger = doc.querySelector(
    'body > div > div > div:nth-child(2) > table > tbody > tr:nth-child(2)',
  ) as HTMLTableRowElement

  assert(tagger.cells[0].textContent === 'tagger')
  let date = tagger.cells[2].textContent
  let author = tagger.cells[1].textContent

  return { name, annotation, date, author } as TagInfo
}

function getDeviceBuildIds(images: DeviceImage[], buildIdsFromFlags: string[]) {
  let hideBuildId = buildIdsFromFlags.length === 1 && buildIdsFromFlags[0] === 'cur'
  return hideBuildId
    ? images.map(c => c.deviceConfig.device.name).join(' ')
    : images.map(c => `${c.deviceConfig.device.name} ${c.buildId}`).join(', ')
}
