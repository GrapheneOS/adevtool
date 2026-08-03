import { Command, Flags } from '@oclif/core'
import assert from 'assert'
import chalk from 'chalk'
import { promises as fs } from 'fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'path'
import util from 'util'
import xml2js from 'xml2js'
import YAML from 'yaml'
import { OS_CHECKOUT_DIR } from '../config/paths'
import { assertDefined, mapGet, updateMultiMap, updateMultiSet } from '../util/data'
import { isDirectory, isFile, listFilesRecursive, readFile } from '../util/fs'
import { spawnGit, spawnGitNoOut } from '../util/git'
import { log } from '../util/log'
import { spawnAsync2, spawnAsyncNoOut, spawnAsyncStdin } from '../util/process'
import { ManifestConfig } from './generate-manifest'

export class ApplyBulletinPatches extends Command {
  static flags = {
    bulletinSource: Flags.file({ char: 'f', required: true, multiple: true }),
    osManifestConfig: Flags.file({ default: path.join(OS_CHECKOUT_DIR, '.repo/manifests/config.yml') }),
    osManifestFile: Flags.file({ default: path.join(OS_CHECKOUT_DIR, '.repo/manifests/default.xml') }),
    keepTempDir: Flags.boolean(),
    commitTitle: Flags.string(),
    outDir: Flags.file({ required: true }),
  }

  async run() {
    let { flags } = await this.parse(ApplyBulletinPatches)
    {
      let outStatus = await spawnGit(flags.outDir, ['status', '--short'])
      if (outStatus !== '') {
        log(`${flags.outDir} is not clean:\n` + outStatus)
        return
      }
    }
    let additionalPatchesDir = path.join(flags.outDir, 'additional-patches')
    let skippedPatchesDir = path.join(flags.outDir, 'patches-to-skip')

    let [additionalPatchesInfo, skippedPatchesInfo] = await Promise.all([
      readPatchesDir(additionalPatchesDir),
      readPatchesDir(skippedPatchesDir),
    ])

    log('Additional patches: ' + util.inspect(additionalPatchesInfo, false, Infinity))
    log('Patches to skip: ' + util.inspect(skippedPatchesInfo, false, Infinity))

    let projectNamePathMap = new Map<string, string>()
    // reverse mapping
    let repoPathProjectNameMap = new Map<string, string>()
    {
      let manifest = await xml2js.parseStringPromise(await readFile(flags.osManifestFile))
      let projects = manifest.manifest.project as XmlElement[]
      for (let proj of projects) {
        let aospName = proj.$['aosp-name']
        if (aospName === undefined) {
          aospName = assertDefined(proj.$.name)
        }
        let path = proj.$.path
        projectNamePathMap.set(aospName, path)
        repoPathProjectNameMap.set(path, aospName)
      }
    }

    let manifestConfig = YAML.parse(await readFile(flags.osManifestConfig)) as ManifestConfig
    let baseAospTag = manifestConfig.aosp_revision
    assert(baseAospTag.startsWith('android-'))
    assert(baseAospTag.includes('.0.0_r'))
    let baseAndroidVersion = baseAospTag.substring('android-'.length, baseAospTag.lastIndexOf('_'))

    let fullRepoPatchesMap = new Map<string, Patch[]>()

    let bulletinDirs: BulletinDir[] = []

    let tmpDir = await fs.mkdtemp(path.join(tmpdir(), 'bulletin-patches-'))

    // collect patches and CVE info from all provided bulletin dirs
    for (let bulletinSrc of flags.bulletinSource) {
      log(`===========================\nchecking ${bulletinSrc}`)

      let srcStat = await fs.stat(bulletinSrc)
      if (!srcStat.isFile()) {
        throw new Error('unknown source ' + util.inspect(srcStat))
      }

      let partSuffix = '.part1'
      if (bulletinSrc.endsWith(partSuffix)) {
        let partsDir = path.dirname(bulletinSrc)
        let dirEntries = await fs.readdir(partsDir, { withFileTypes: true })
        let srcFileName = path.basename(bulletinSrc)
        let base = srcFileName.slice(0, -1)
        let parts = dirEntries.filter(de => de.isFile() && de.name.startsWith(base)).map(de => de.name)
        parts.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        let out = path.join(tmpDir, srcFileName.slice(0, -partSuffix.length))
        log('combining ' + parts + ' into ' + out)
        for (let part of parts) {
          await fs.appendFile(out, await fs.readFile(path.join(partsDir, part)))
        }
        bulletinSrc = out
      }

      let unpackedSrc = path.join(tmpDir, path.basename(bulletinSrc) + '-dir')
      await fs.mkdir(unpackedSrc)

      let type: BulletinType

      if (bulletinSrc.endsWith('.zip')) {
        type = BulletinType.FinalSigned
        let res = await spawnAsync2({
          command: '/bin/unzip',
          args: ['-q', bulletinSrc],
          spawnOpts: { cwd: unpackedSrc },
        })
        assert(res.length === 0)
      } else if (bulletinSrc.includes('.tar.')) {
        type = BulletinType.Beta
        // use OS variants of tar and xzcat since AOSP prebuilts are much slower as of Android 17
        let res = await spawnAsync2({
          command: '/bin/tar',
          args: ['--extract', '--use-compress-program=/bin/xzcat', `--file=${bulletinSrc}`],
          spawnOpts: { cwd: unpackedSrc, stdio: 'inherit' },
        })
        assert(res.length === 0)
      } else {
        throw new Error('unknown source ' + bulletinSrc)
      }

      if (type === BulletinType.Beta) {
        let psbDir = path.join(unpackedSrc, 'Partner Security Bulletin')
        assert(await isDirectory(psbDir), psbDir)
        let bpbDir = path.join(psbDir, 'Beta Partner Bulletins')
        assert(await isDirectory(bpbDir), bpbDir)

        for (let year of (await fs.readdir(bpbDir)).sort()) {
          let yearDir = path.join(bpbDir, year)
          for (let yearMonth of (await fs.readdir(yearDir)).sort()) {
            let versionsDir = path.join(yearDir, yearMonth, 'ANDROID')
            assert(await isDirectory(versionsDir), versionsDir)
            let versions = (await fs.readdir(versionsDir)).sort((a, b) =>
              a.localeCompare(b, undefined, { numeric: true }),
            )
            assert(versions.length > 0, versionsDir)
            for (let version of versions) {
              if (version.match('^v[0-9]+$') === null) {
                throw new Error('invalid versions dir ' + versionsDir + ' ; ' + versions)
              }
            }
            let latestVersionDir = path.join(versionsDir, versions[versions.length - 1])

            let patchesIndexSuffix = '-patches-index.json'
            let indices = (await fs.readdir(latestVersionDir))
              .filter(e => e.endsWith(patchesIndexSuffix))
              .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            assert(indices.length > 0, latestVersionDir)
            log('found ' + indices[indices.length - 1])

            let indexName = indices[indices.length - 1]
            let baseName = indexName.slice(0, -patchesIndexSuffix.length)
            let bulletinJsonPath = path.join(latestVersionDir, baseName + '.json')
            assert(await isFile(bulletinJsonPath), bulletinJsonPath)
            let subVersionIndex = baseName.lastIndexOf('_v')
            let subVersion = ''
            if (subVersionIndex > 0) {
              subVersion = baseName.substring(subVersionIndex)
            }
            let patchesDirPath = path.join(latestVersionDir, 'patches' + subVersion)
            assert(await isDirectory(patchesDirPath), patchesDirPath)

            let patchIndexJsonPath = path.join(latestVersionDir, indexName)
            assert(await isFile(patchIndexJsonPath), patchIndexJsonPath)

            bulletinDirs.push({
              type: BulletinType.Beta,
              baseDir: latestVersionDir,
              yearMonth,
              bulletinJsonPath,
              patchIndexJsonPath,
              patchesDirPath,
            })
          }
        }
      } else if (type === BulletinType.FinalSigned) {
        let dirs = await fs.readdir(unpackedSrc)
        assert(dirs.length === 1)
        let yearMonth = dirs[0]
        let basePath = path.join(unpackedSrc, yearMonth)
        let patchIndices = (await fs.readdir(basePath)).filter(e => e.endsWith('-patches-index.json'))
        assert(patchIndices.length === 1, util.inspect(patchIndices))
        let patchIndexJsonName = patchIndices[0]
        let namePrefixLength = (yearMonth + '-android-bulletin-partner-preview').length
        let nameSuffixLength = '-patches-index.json'.length
        assert(namePrefixLength + nameSuffixLength <= patchIndexJsonName.length, patchIndexJsonName)
        let nameInfix = patchIndexJsonName.substring(namePrefixLength, patchIndexJsonName.length - nameSuffixLength)
        let patchIndexJsonPath = path.join(basePath, patchIndexJsonName)
        assert(await isFile(patchIndexJsonPath), patchIndexJsonPath)

        let bulletinJsonPath = path.join(
          basePath,
          yearMonth + '-android-bulletin-partner-preview' + nameInfix + '.json',
        )
        assert(await isFile(bulletinJsonPath), bulletinJsonPath)
        let patchesZip = path.join(
          basePath,
          yearMonth + '-android-bulletin-partner-preview' + nameInfix + '-patches.zip',
        )
        assert(await isFile(patchIndexJsonPath), patchesZip)
        let res = await spawnAsync2({
          command: '/bin/unzip',
          args: ['-q', patchesZip],
          spawnOpts: { cwd: basePath },
        })
        assert(res.length === 0)
        let patchesDirPath = path.join(
          basePath,
          yearMonth + '-android-bulletin-partner-preview' + nameInfix + '-patches/patches',
          manifestConfig.aosp_revision,
        )
        assert(await isDirectory(patchesDirPath), patchesDirPath)
        bulletinDirs.push({
          type: BulletinType.FinalSigned,
          baseDir: basePath,
          yearMonth,
          bulletinJsonPath,
          patchIndexJsonPath,
          patchesDirPath,
        })
      }
    }

    // collect patches and CVE info from all provided bulletin sources
    for (let bulletinDir of bulletinDirs) {
      log(`===========================\nprocessing ${bulletinDir.yearMonth}: '${bulletinDir.baseDir}'`)

      let patchesIndex = JSON.parse(await readFile(bulletinDir.patchIndexJsonPath)) as SecurityBulletinPatchesIndex
      if (patchesIndex.patches === undefined) {
        log('no patches for any Android version')
        continue
      }
      let patches = patchesIndex.patches[baseAospTag]
      if (patches === undefined) {
        log('no patches for ' + baseAospTag)
        continue
      }
      let repoShasMap = new Map<string, string[]>()
      let repoShasSetMap = new Map<string, Set<string>>()
      for (let repoPatches of patches.projects) {
        let repo = assertDefined(repoPatches.repo)
        assert(!repoShasSetMap.has(repo))
        repoShasSetMap.set(repo, new Set(assertDefined(repoPatches.shas)))
        assert(!repoShasMap.has(repo))
        repoShasMap.set(repo, repoPatches.shas)
      }

      let bulletin = JSON.parse(await readFile(bulletinDir.bulletinJsonPath)) as BulletinInfo

      let cveInfoMap = new Map<string, Set<string>>() // patch SHA -> patch CVE infos

      for (let vuln of bulletin.vulnerabilities) {
        let cve = vuln.CVE
        if (cve === undefined || vuln.version_data === undefined) {
          continue
        }
        let versionData = vuln.version_data[baseAndroidVersion]
        if (versionData === undefined) {
          continue
        }
        let branches = versionData.branches
        assert(branches.length === 1)
        let severity = assertDefined(versionData.severity, cve)
        let type = assertDefined(versionData.type, cve)
        let cveInfo = [cve, CVE_INFO_SEVERITY_PREFIX + severity, CVE_INFO_TYPE_PREFIX + type].join(
          CVE_INFO_ITEM_SEPARATOR,
        )
        for (let data of branches[0].projects) {
          let repo = assertDefined(data.repo)
          let presentShas = assertDefined(repoShasSetMap.get(repo))
          for (let sha of assertDefined(data.shas)) {
            assert(presentShas.has(sha), sha)
            updateMultiSet(cveInfoMap, sha, cveInfo)
          }
        }
      }

      let shaPatchMap: Map<string, string> | null = null // commit hash -> patch path
      if (bulletinDir.type === BulletinType.FinalSigned) {
        shaPatchMap = await readPatchesFromFinalBulletinDir(bulletinDir)
      }

      for (let [repo, shas] of repoShasMap.entries()) {
        let repoPath = projectNamePathMap.get(repo)
        if (repoPath === undefined) {
          log('WARNING: skipping missing repo ' + repo)
          continue
        }
        let skippedPatchesArr = await Promise.all(
          (skippedPatchesInfo.patchMap.get(repoPath) ?? []).map(async patchPath => readFile(patchPath)),
        )
        let skippedPatches = new Set(skippedPatchesArr)
        assert(skippedPatches.size === skippedPatchesArr.length)
        let repoPatches: Patch[] = []
        for (let sha of shas) {
          let filePath: string
          switch (bulletinDir.type) {
            case BulletinType.Beta:
              filePath = path.join(bulletinDir.patchesDirPath, sha + '.patch')
              break
            case BulletinType.FinalSigned:
              assert(shaPatchMap !== null)
              filePath = mapGet(shaPatchMap, sha)
              break
          }
          let patch: string = await readFile(filePath)
          if (skippedPatches.has(patch)) {
            continue
          }
          let patchMessageStartMarker = '\n\n'
          let patchMessageStart = patch.indexOf(patchMessageStartMarker)
          assert(patchMessageStart > 0)
          let patchHeader = patch.substring(0, patchMessageStart)
          let cveInfoSet = cveInfoMap.get(sha)
          let patchContents: string
          if (cveInfoSet !== undefined) {
            let cveInfoStr =
              '\n' +
              Array.from(cveInfoSet)
                .sort()
                .map(s => CVE_INFO_HEADER + s)
                .join('')
            patchContents = patchHeader + cveInfoStr + patch.substring(patchMessageStart)
          } else {
            patchContents = patch
          }
          repoPatches.push({
            patchContents: patchContents,
            srcFilePath: filePath,
            isAdditional: false,
          })
        }
        if (repoPatches.length === 0) {
          continue
        }

        let fullRepoPatches = fullRepoPatchesMap.get(repo)
        if (fullRepoPatches === undefined) {
          fullRepoPatches = []
          fullRepoPatchesMap.set(repo, fullRepoPatches)
        }
        fullRepoPatches.push(...repoPatches)
      }
    }

    log('===========================')

    for (let [repoPath, patchPaths] of additionalPatchesInfo.patchMap) {
      let repo = mapGet(repoPathProjectNameMap, repoPath)
      let fullRepoPatches = fullRepoPatchesMap.get(repo)
      if (fullRepoPatches === undefined) {
        fullRepoPatches = []
        fullRepoPatchesMap.set(repo, fullRepoPatches)
      }
      let patches = await Promise.all(
        patchPaths.toSorted().map(async patchPath => {
          return {
            srcFilePath: patchPath,
            patchContents: await readFile(patchPath),
            isAdditional: true,
          } as Patch
        }),
      )
      fullRepoPatches.push(...patches)
    }

    let patchedRepos: PatchedRepo[] = []
    let repoNames = Array.from(fullRepoPatchesMap.keys()).sort()

    for (let repoName of repoNames) {
      let patches = mapGet(fullRepoPatchesMap, repoName)
      assert(patches.length > 0)
      let repoPath = mapGet(projectNamePathMap, repoName)
      log(chalk.bold(repoPath))

      let baseRevision = await spawnGit(repoPath, ['rev-parse', 'HEAD'])
      assert(baseRevision.endsWith('\n'))
      baseRevision = baseRevision.slice(0, -1)

      let additionalPatches: Patch[] = []
      for (let patchObj of patches) {
        if (patchObj.isAdditional) {
          additionalPatches.push(patchObj)
          continue
        }
        let patch = patchObj.patchContents
        let subjectStartMarker = '\nSubject: '
        let subjectStart = patch.indexOf(subjectStartMarker)
        assert(subjectStart > 0)
        subjectStart += subjectStartMarker.length
        let headerEnd = patch.indexOf('\n\n')
        assert(headerEnd > subjectStart)
        let subject = patch.substring(subjectStart, headerEnd).replaceAll('\n', '')

        let amOut
        try {
          amOut = await spawnAsyncStdin(
            'git',
            ['-C', repoPath, 'am', '--3way', '--whitespace=nowarn'],
            Buffer.from(patch),
            line => line === 'warning: reading patches from stdin/tty...',
          )
        } catch (e) {
          log(`\nUnable to apply "${subject}" (path: '${patchObj.srcFilePath}'): ${e}`)
          await spawnGit(repoPath, ['am', '--abort'])
          patchedRepos.push({ path: repoPath, baseRevision })
          await Promise.all(patchedRepos.map(async e => spawnGit(e.path, ['checkout', '--quiet', e.baseRevision])))
          log('Discarded applied patches')
          return
        }
        assert(amOut.endsWith('\n'))
        log(amOut.slice(0, -1))
      }

      await applyAdditionalPatches(repoPath, additionalPatches)

      if (spawnSync('git', ['-C', repoPath, 'diff', '--exit-code', 'HEAD', baseAospTag]).status !== 0) {
        patchedRepos.push({ path: repoPath, baseRevision })
      } else {
        log(`${repoPath}: ${baseAospTag} is same as HEAD`)
      }
    }

    {
      let origPatchesDir = path.join(flags.outDir, 'original-patches')
      await fs.rm(origPatchesDir, { recursive: true, force: true })
      await fs.mkdir(origPatchesDir, { recursive: true })
      let copies: Promise<void>[] = []
      for (let dir of bulletinDirs) {
        let dstDir = path.join(origPatchesDir, dir.yearMonth)
        await fs.mkdir(dstDir)
        let files = [dir.bulletinJsonPath, dir.patchIndexJsonPath]
        let baseBulletinPath = dir.bulletinJsonPath.slice(0, -'json'.length)
        files.push(baseBulletinPath + 'csv')
        files.push(baseBulletinPath + 'html')
        for (let file of files) {
          copies.push(fs.copyFile(file, path.join(dstDir, path.basename(file))))
        }
        copies.push(spawnAsyncNoOut('cp', ['-r', dir.patchesDirPath, dstDir]))
      }
      await Promise.all(copies)
    }

    if (!flags.keepTempDir) {
      await fs.rm(tmpDir, { recursive: true })
    }

    log('')

    let processedPatchesDir = path.join(flags.outDir, 'processed-patches')
    await fs.rm(processedPatchesDir, { recursive: true, force: true })
    await fs.mkdir(processedPatchesDir, { recursive: true })

    await Promise.all(
      patchedRepos.map(async e =>
        spawnGit(e.path, [
          'format-patch',
          '--keep-subject',
          '--zero-commit',
          '--no-signature',
          '--output-directory',
          path.join(processedPatchesDir, e.path),
          e.baseRevision,
        ]),
      ),
    )

    await Promise.all(patchedRepos.map(async e => spawnGit(e.path, ['checkout', '--quiet', e.baseRevision])))

    {
      let cveInfoMap = new Map<string, Set<string>>() // severity -> CVEs

      let patchPaths = await Array.fromAsync(listFilesRecursive(processedPatchesDir))
      await Promise.all(
        patchPaths.map(async patchPath => {
          assert(patchPath.endsWith('.patch'))
          let patch = await readFile(patchPath)
          let searchStartIdx = 0
          for (;;) {
            let cveInfoHeaderIdx = patch.indexOf(CVE_INFO_HEADER, searchStartIdx)
            if (cveInfoHeaderIdx < searchStartIdx) {
              return
            }
            let cveInfoStart = cveInfoHeaderIdx + CVE_INFO_HEADER.length
            let cveInfoEnd = patch.indexOf('\n', cveInfoStart)
            assert(cveInfoEnd > cveInfoStart)
            let cveInfoStr = patch.substring(cveInfoStart, cveInfoEnd)
            let cveInfo = cveInfoStr.split(CVE_INFO_ITEM_SEPARATOR)
            assert(cveInfo.length >= 2)
            let [cve, severityStr] = cveInfo
            assert(severityStr.startsWith(CVE_INFO_SEVERITY_PREFIX))
            let severity = severityStr.substring(CVE_INFO_SEVERITY_PREFIX.length)
            updateMultiSet(cveInfoMap, severity, cve)
            searchStartIdx = cveInfoEnd
          }
        }),
      )

      let cveInfoStr =
        Array.from(cveInfoMap.entries())
          .map(([severity, cves]) => {
            return severity + '\n' + Array.from(cves).toSorted().join('\n')
          })
          .toSorted()
          .join('\n\n') + '\n'
      await fs.writeFile(path.join(processedPatchesDir, 'cve-info.txt'), cveInfoStr)
      let cveInfoHtml =
        Array.from(cveInfoMap.entries())
          .map(([severity, cves]) => {
            if (severity === 'Unknown') {
              severity = 'Unclassified'
            }
            return '                        <li>' + severity + ': ' + Array.from(cves).toSorted().join(', ') + '</li>'
          })
          .toSorted()
          .join('\n') + '\n'
      await fs.writeFile(path.join(processedPatchesDir, 'cve-info-html-fragment.txt'), cveInfoHtml)
    }

    let applyScript = [
      '#!/bin/bash',
      '',
      'set -e',
      '[[ $# -ne 1 ]] && (echo expected OS checkout root as the single argument; exit 1)',
      'BASE_DIR=$(realpath $(dirname "$0"))',
      'CHECKOUT_ROOT=$(realpath $1)',
      '',
      'readonly patched_repos=(',
      ...patchedRepos.map(e => `    ${e.path}`).toSorted(),
      ')',
      '',
      'for repo in ${patched_repos[@]}; do',
      '    echo',
      '    echo Patching $repo',
      '    git -C $CHECKOUT_ROOT/$repo am --whitespace=nowarn $BASE_DIR/$repo/*.patch',
      'done',
      '',
      `sed -i 's/for channel in ("beta", "stable", "alpha", "testing"):/for channel in ("beta-security-preview", "stable-security-preview", "alpha-security-preview", "testing-security-preview"):/g' $CHECKOUT_ROOT/script/generate-metadata`,
      'echo',
      'echo Patched $CHECKOUT_ROOT/script/generate-metadata',
      '',
    ].join('\n')

    await fs.writeFile(path.join(processedPatchesDir, 'apply.sh'), applyScript, { mode: 0o700 })

    let outStatus = await spawnGit(flags.outDir, ['status', '--short'])
    if (outStatus === '') {
      log(`${flags.outDir} is unchanged`)
    } else {
      let commitMessage = flags.commitTitle
      if (commitMessage === undefined) {
        let fileName = path.basename(flags.bulletinSource[flags.bulletinSource.length - 1])
        commitMessage = fileName.substring(0, fileName.indexOf('.'))
      }
      await spawnGitNoOut(flags.outDir, ['add', flags.outDir])
      let commitOut = await spawnGit(flags.outDir, ['commit', '--message', commitMessage])
      log(commitOut)
    }
  }
}

async function readPatchesFromFinalBulletinDir(dir: BulletinDir) {
  assert(dir.type === BulletinType.FinalSigned)
  let res = new Map<string, string>()
  for await (let patchPath of listFilesRecursive(dir.patchesDirPath)) {
    let contents = await readFile(patchPath)
    let lineEnd = contents.indexOf('\n')
    assert(lineEnd > 0, contents)
    let firstLine = contents.slice(0, lineEnd)
    assert(firstLine.length === 70, firstLine)
    let prefix = 'From '
    let suffix = ' Mon Sep 17 00:00:00 2001'
    assert(firstLine.startsWith(prefix))
    assert(firstLine.endsWith(suffix))
    let commitHash = firstLine.slice(prefix.length, firstLine.length - suffix.length)
    assert(commitHash.length === 40)
    res.set(commitHash, patchPath)
  }
  return res
}

async function applyAdditionalPatches(repoPath: string, patches: Patch[]) {
  for (let patchObj of patches) {
    let amOut = await spawnAsyncStdin(
      'git',
      ['-C', repoPath, 'am', '--3way', '--whitespace=nowarn'],
      Buffer.from(patchObj.patchContents),
      line => line === 'warning: reading patches from stdin/tty...',
    )
    assert(amOut.endsWith('\n'))
    log('Additional patch: ' + amOut.slice(0, -1))
  }
}

const CVE_INFO_HEADER = '\nCVE-Info: '
const CVE_INFO_ITEM_SEPARATOR = ' | '
const CVE_INFO_SEVERITY_PREFIX = 'Severity: '
const CVE_INFO_TYPE_PREFIX = 'Type: '

interface Patch {
  patchContents: string // won't be same as contents of srcFilePath in most cases due to editing
  srcFilePath: string
  isAdditional: boolean
}

interface PatchesDir {
  // repo path -> patches
  patchMap: Map<string, string[]>
}

async function readPatchesDir(dirPath: string) {
  if (!(await isDirectory(dirPath))) {
    return { patchMap: new Map() } as PatchesDir
  }

  let patchMap = new Map<string, string[]>()
  for await (let filePath of listFilesRecursive(dirPath)) {
    if (!filePath.endsWith('.patch')) {
      continue
    }
    updateMultiMap(patchMap, path.dirname(path.relative(dirPath, filePath)), filePath)
  }
  return { patchMap } as PatchesDir
}

enum BulletinType {
  Beta,
  FinalSigned,
}

interface BulletinDir {
  type: BulletinType
  yearMonth: string
  baseDir: string
  bulletinJsonPath: string
  patchIndexJsonPath: string
  patchesDirPath: string // directory if BulletinType is Beta, zip if BulletinType is FinalSigned
}

interface XmlElement {
  $: Record<string, string>
}

interface PatchedRepo {
  path: string
  baseRevision: string
}

interface SecurityBulletinPatchesIndex {
  patches: { [tag: string]: SecurityBulletinPatches }
}

interface SecurityBulletinPatches {
  branch: string
  projects: RepoPatches[]
}

interface RepoPatches {
  repo: string
  shas: string[]
}

interface BulletinInfo {
  title: string
  bulletin_id: string
  published: string
  vulnerabilities: Vulnerability[]
}

interface Vulnerability {
  bulletin_id: string
  CVE?: string
  area: string
  component: string
  subcomponent?: string
  patch_level: string
  android_id: string
  type?: string
  severity: string
  aosp_versions: string[]
  tech_details: string
  fix_details?: string
  version_data?: { [versionName: string]: VulnVersionData }
}

interface VulnVersionData {
  type: string
  severity: string
  patch_links: string[]
  branches: VulnVersionBranchData[]
}

interface VulnVersionBranchData {
  name: string
  projects: VulnProjectData[]
}

interface VulnProjectData {
  repo: string
  shas: string[]
}
