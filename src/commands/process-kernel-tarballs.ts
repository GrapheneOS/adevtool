import { confirm } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import { promises as fs } from 'fs'

import assert from 'assert'
import { Semaphore } from 'async-mutex'
import chalk from 'chalk'
import { spawnSync } from 'node:child_process'
import path from 'path'
import { assertDefined, compareStrings, updateMultiMap } from '../util/data'
import { isDirectory, isFile, readFile } from '../util/fs'
import { spawnGit } from '../util/git'
import { log } from '../util/log'
import { spawnAsyncNoOut } from '../util/process'

interface KernelDir {
  targetName: string | null
  buildNumber: number
  dirPath: string
  srcName: string
  osBuildId: string
  sourceIdx: number
}

interface ReferenceKernelDir {
  dir: KernelDir
  targetNames: string[]
}

export class ProcessKernelTarballs extends Command {
  static description = 'Convert Pixel kernel tarballs into git commits'

  static flags = {
    sources: Flags.string({ char: 's', required: true, multiple: true }),
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

    let sourceNamePrefix = 'kernels-'
    let tarballExtension = '.tar.xz'

    for (let src of flags.sources) {
      assert(path.basename(src).startsWith(sourceNamePrefix), src)
      if (src.endsWith(tarballExtension)) {
        assert(await isFile(src), src)
      } else {
        assert(await isDirectory(src), src)
      }
    }

    let repoNameStem = path.basename(flags.repoPathStem)
    let dirtyRepos: string[] = []
    for (let de of await fs.readdir(path.dirname(flags.repoPathStem), { withFileTypes: true })) {
      if (!de.isDirectory()) {
        continue
      }
      if (!de.name.startsWith(repoNameStem)) {
        continue
      }
      let repoPath = path.join(de.parentPath, de.name)
      let outStatus = await spawnGit(repoPath, ['status', '--short'])
      if (outStatus !== '') {
        log(`${repoPath} is not clean:\n` + outStatus)
        dirtyRepos.push(repoPath)
      }
    }
    if (dirtyRepos.length > 0) {
      throw new Error('the following repos are not clean:\n' + dirtyRepos.join('\n'))
    }

    let referenceKernelDirs: ReferenceKernelDir[] = []

    let unpackedTars: string[] = []
    await Promise.all(
      flags.sources.map(async (sourcePath, sourceIdx) => {
        let buildNumberMap = new Map<number, KernelDir[]>()
        if (sourcePath.endsWith(tarballExtension)) {
          let unpackedDir = await fs.mkdtemp(
            path.join(path.dirname(flags.repoPathStem), path.basename(sourcePath)) + '-',
          )
          await untar(sourcePath, unpackedDir)
          unpackedTars.push(unpackedDir)

          let osBuildId = path.basename(sourcePath).slice(sourceNamePrefix.length, -tarballExtension.length)
          for (let de of await fs.readdir(unpackedDir, { withFileTypes: true })) {
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
              srcName: de.name,
              osBuildId,
              sourceIdx,
            }
            updateMultiMap(buildNumberMap, buildNumber, dir)
          }
        } else {
          let osBuildId = path.basename(sourcePath).slice(sourceNamePrefix.length)
          await Promise.all(
            (await fs.readdir(sourcePath, { withFileTypes: true })).map(async de => {
              assert(de.isFile(), de.name)
              assert(de.name.endsWith(tarballExtension), de.name)
              let srcName = de.name.slice(0, -tarballExtension.length)
              let unpackedDir = await fs.mkdtemp(path.join(path.dirname(flags.repoPathStem), de.name + '-'))
              await untar(path.join(de.parentPath, de.name), unpackedDir)
              let unpackedEntries = await fs.readdir(unpackedDir)
              assert(unpackedEntries.length === 1 && unpackedEntries[0] === srcName, de.name)
              unpackedTars.push(unpackedDir)
              let parts = srcName.split('-')

              assert(parts.length === 3 || parts.length === 2, de.name)
              assert(parts[0] === 'kernel', de.name)
              let buildNumber = Number(parts.length === 3 ? parts[2] : parts[1])
              assert(Number.isSafeInteger(buildNumber), de.name)

              let dir: KernelDir = {
                targetName: parts.length === 3 ? parts[1] : null,
                buildNumber,
                dirPath: path.join(unpackedDir, srcName),
                srcName,
                osBuildId,
                sourceIdx,
              }
              updateMultiMap(buildNumberMap, buildNumber, dir)
            }),
          )
        }
        await Promise.all(
          buildNumberMap.values().map(async dirs => {
            let sortedDirs = dirs.toSorted((a, b) => compareStrings(a.srcName, b.srcName))
            let reference = sortedDirs[0]
            if (sortedDirs.length > 1) {
              log('checking for duplicates among ' + sortedDirs.map(e => e.srcName).join(', '))
              await Promise.all(
                sortedDirs.slice(1).map(async dir => {
                  await assertDirsAreEqual(reference.dirPath, dir.dirPath)
                  log(`${reference.osBuildId}: checked that ${reference.srcName} and ${dir.srcName} are the same`)
                }),
              )
            }
            let targetNames = sortedDirs
              .map(e => e.targetName)
              .filter(e => e !== null)
              .sort()
            let dir: ReferenceKernelDir = {
              dir: reference,
              targetNames,
            }
            referenceKernelDirs.push(dir)
          }),
        )
      }),
    )

    referenceKernelDirs.sort((a, b) => a.dir.buildNumber - b.dir.buildNumber || a.dir.sourceIdx - b.dir.sourceIdx)

    log(
      chalk.bold('unique trees:') +
        '\n' +
        referenceKernelDirs.map(e => `- ${e.dir.osBuildId}: ${e.dir.srcName}`).join('\n'),
    )

    let checkedOutRepos = new Set<string>()

    for (let referenceKernelDir of referenceKernelDirs) {
      let kernelDir = referenceKernelDir.dir
      let branchLinePrefix = 'BRANCH='
      let branchLine
      for (let fileName of ['build.config.constants', 'build.config.common']) {
        let filePath = path.join(kernelDir.dirPath, 'common/ack', fileName)
        if (!(await isFile(filePath))) {
          continue
        }
        branchLine = (await readFile(filePath)).split('\n').find(line => line.startsWith(branchLinePrefix))
        if (branchLine !== undefined) {
          break
        }
      }

      let branchName = assertDefined(branchLine, kernelDir.dirPath).slice(branchLinePrefix.length)
      let branchNameParts = branchName.split('-')
      assert(branchNameParts.length === 2, branchName)
      assert(branchNameParts[0].startsWith('android'), branchName)
      let kernelVersion = branchNameParts[1]

      let repoPath = flags.repoPathStem + kernelVersion
      log('handling ' + kernelDir.srcName + ', target repo is ' + repoPath)
      {
        let outStatus = await spawnGit(repoPath, ['status', '--short'])
        if (outStatus !== '') {
          throw new Error(`${repoPath} is not clean:\n` + outStatus)
        }
      }
      if (!checkedOutRepos.has(repoPath)) {
        log(`fetching ${flags.baseRef} in ${repoPath}`)
        await spawnGit(repoPath, ['fetch', '--quiet', dstRemote, dstBranch])
        await spawnGit(repoPath, ['checkout', '--quiet', '--force', 'FETCH_HEAD'], l =>
          l.startsWith('warning: unable to rmdir '),
        )
        await spawnGit(repoPath, ['clean', '-fdx'])
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
        (await fs.readdir(kernelDir.dirPath, { withFileTypes: true })).map(async de => {
          await fs.rename(path.join(de.parentPath, de.name), path.join(repoPath, de.name))
        }),
      )
      log('replaced contents of ' + repoPath)
      await spawnGit(repoPath, ['add', '--all', '--force', '.'])
      log('added new contents to git')
      let names = referenceKernelDir.targetNames
      let commitMsg = `${kernelDir.osBuildId} ${kernelDir.buildNumber}${names.length > 0 ? ` ${names.join(' ')}` : ''}`
      log(await spawnGit(repoPath, ['commit', '--allow-empty', '--message', commitMsg]))
    }

    await Promise.all(
      unpackedTars.map(async dirPath => {
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

let semaphore = new Semaphore(2)

async function untar(srcPath: string, dstDir: string) {
  await semaphore.runExclusive(async () => {
    log('unpacking ' + srcPath + ' into ' + dstDir)
    // use OS variants of tar and xzcat since AOSP prebuilts are much slower as of Android 17
    await spawnAsyncNoOut('/bin/tar', [
      '--extract',
      '--use-compress-program=/bin/xzcat',
      '--file',
      srcPath,
      '--directory',
      dstDir,
    ])
    log('unpacked ' + srcPath)
  })
}

async function assertDirsAreEqual(dirA: string, dirB: string) {
  // plain diff doesn't compare file permission bits, git diff does compare them
  await spawnAsyncNoOut('git', ['diff', '--no-index', '--name-status', dirA, dirB])
}
