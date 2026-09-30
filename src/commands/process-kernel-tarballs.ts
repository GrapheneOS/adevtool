import { confirm } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import { promises as fs } from 'fs'

import assert from 'assert'
import { spawnSync } from 'node:child_process'
import path from 'path'
import { assertDefined, mapGet, updateMultiMap } from '../util/data'
import { readFile } from '../util/fs'
import { spawnGit } from '../util/git'
import { log } from '../util/log'
import { spawnAsyncNoOut } from '../util/process'

interface KernelDir {
  targetName: string | null
  buildNumber: number
  dirPath: string
  dirName: string
}

export class ProcessKernelTarballs extends Command {
  static description = 'Convert Pixel kernel tarballs into git commits'

  static flags = {
    tarballs: Flags.file({ char: 'f', required: true, multiple: true }),
    repoPathStem: Flags.string({
      char: 'd',
      required: true,
      description: 'Stem of destination repo paths. Automatically suffixed with kernel version name (e.g. 6.12).',
    }),
    baseRef: Flags.string({
      required: true,
      description:
        'git branch that will be checked out in destination repos before first commit. Format: <remote>/<branch>',
    }),
  }

  async run() {
    let { flags } = await this.parse(ProcessKernelTarballs)

    let baseRefParts = flags.baseRef.split('/')
    assert(baseRefParts.length === 2 && baseRefParts.every(p => p !== ''), flags.baseRef)
    let [dstRemote, dstBranch] = baseRefParts

    let tarballPrefix = 'kernels-'
    let tarballExtension = '.tar.xz'
    for (let tarPath of flags.tarballs) {
      assert(tarPath.endsWith(tarballExtension), tarPath)
      assert(path.basename(tarPath).startsWith(tarballPrefix), tarPath)
    }

    let unpackedTars = await Promise.all(
      flags.tarballs.map(async tarPath => {
        let unpackedDir = await fs.mkdtemp(path.join(path.dirname(flags.repoPathStem), path.basename(tarPath)) + '-')
        log('unpacking ' + tarPath + ' into ' + unpackedDir)
        // use OS variants of tar and xzcat since AOSP prebuilts are much slower as of Android 17
        await spawnAsyncNoOut('/bin/tar', [
          '--extract',
          '--use-compress-program=/bin/xzcat',
          '--file',
          tarPath,
          '--directory',
          unpackedDir,
        ])
        log('unpacked ' + tarPath)
        return [path.basename(tarPath), unpackedDir]
      }),
    )

    let checkedOutRepos = new Set<string>()

    for (let [tarballName, unpackedTar] of unpackedTars) {
      log('processing ' + unpackedTar)
      let buildNumberMap = new Map<number, KernelDir[]>()
      for (let de of await fs.readdir(unpackedTar, { withFileTypes: true })) {
        assert(de.isDirectory(), de.name)
        let parts = de.name.split('-')
        assert(parts.length === 3 || parts.length === 2, de.name)
        assert(parts[0] === 'kernel', de.name)
        let buildNumber = Number(parts.length === 3 ? parts[2] : parts[1])
        assert(Number.isSafeInteger(buildNumber), de.name)
        let dir: KernelDir = {
          targetName: parts.length === 3 ? parts[1] : null,
          buildNumber,
          dirPath: path.join(de.parentPath, de.name),
          dirName: de.name,
        }
        updateMultiMap(buildNumberMap, dir.buildNumber, dir)
      }
      await Promise.all(
        buildNumberMap.values().map(async dirs => {
          if (dirs.length === 1) {
            return
          }
          let reference = dirs[0]
          await Promise.all(
            dirs.slice(1).map(async dir => {
              // plain diff doesn't compare file permission bits, git diff does compare them
              await spawnAsyncNoOut('git', ['diff', '--no-index', '--name-status', reference.dirPath, dir.dirPath])
              log(`checked that ${reference.dirName} and ${dir.dirName} are the same`)
            }),
          )
        }),
      )

      let osBuildId = tarballName.slice(tarballPrefix.length, -tarballExtension.length)

      for (let buildNumber of Array.from(buildNumberMap.keys()).sort((a, b) => a - b)) {
        let dirs = mapGet(buildNumberMap, buildNumber)
        let reference = dirs[0]
        let branchLinePrefix = 'BRANCH='
        let branchLine = (await readFile(path.join(reference.dirPath, 'common/ack/build.config.constants')))
          .split('\n')
          .find(line => line.startsWith(branchLinePrefix))

        let branchName = assertDefined(branchLine, reference.dirPath).slice(branchLinePrefix.length)
        let branchNameParts = branchName.split('-')
        assert(branchNameParts.length === 2, branchName)
        assert(branchNameParts[0].startsWith('android'), branchName)
        let kernelVersion = branchNameParts[1]

        let repoPath = flags.repoPathStem + kernelVersion
        {
          let outStatus = await spawnGit(repoPath, ['status', '--short'])
          if (outStatus !== '') {
            throw new Error(`${repoPath} is not clean:\n` + outStatus)
          }
        }
        if (!checkedOutRepos.has(repoPath)) {
          log(`fetching ${flags.baseRef} in ${repoPath}`)
          await spawnGit(repoPath, ['fetch', '--quiet', dstRemote, dstBranch])
          await spawnGit(repoPath, ['checkout', '--quiet', 'FETCH_HEAD'])
          log(`checked out ${flags.baseRef} in ${repoPath}`)
          checkedOutRepos.add(repoPath)
        }
        await Promise.all(
          (await fs.readdir(repoPath, { withFileTypes: true })).map(async de => {
            if (de.name === '.git') {
              return
            }
            let dePath = path.join(de.parentPath, de.name)
            if (de.isDirectory()) {
              await fs.rm(dePath, { recursive: true })
            } else {
              assert(de.isFile() || de.isSymbolicLink(), dePath)
              await fs.rm(dePath)
            }
          }),
        )
        await Promise.all(
          (await fs.readdir(reference.dirPath, { withFileTypes: true })).map(async de => {
            await fs.rename(path.join(de.parentPath, de.name), path.join(repoPath, de.name))
          }),
        )
        log('replaced contents of ' + repoPath)
        await spawnGit(repoPath, ['add', '--all', '--force', '.'])
        log('added new contents to git')
        let names = dirs.map(dir => dir.targetName).filter(name => name !== null)
        names.sort()
        let commitMsg = `${osBuildId} ${reference.buildNumber}${names.length > 0 ? ` ${names.join(' ')}` : ''}`
        log(await spawnGit(repoPath, ['commit', '--allow-empty', '--message', commitMsg]))
      }
    }

    await Promise.all(
      unpackedTars.map(async ([_, dirPath]) => {
        await fs.rm(dirPath, { recursive: true })
        log(`deleted ${dirPath}`)
      }),
    )

    let dstRefspec = `HEAD:refs/heads/${dstBranch}`

    if (
      await confirm({
        message: `Run 'git push ${dstRemote} ${dstRefspec}' in the following repos?\n${Array.from(checkedOutRepos).join('\n')}\n`,
      })
    ) {
      for (let repo of checkedOutRepos) {
        log(`pushing ${repo}`)
        spawnSync('git', ['-C', repo, 'push', dstRemote, dstRefspec], { stdio: 'inherit' })
      }
    }
  }
}
