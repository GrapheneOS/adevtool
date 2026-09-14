import assert from 'assert'
import { spawnAsync, spawnAsyncNoOut } from './process'

export class GitLsRemote {
  tags = new Map<string, string>()
  branches = new Map<string, string>()

  static async get(repoUrl: string) {
    let lsRemote = await spawnAsync('git', ['ls-remote', '--tags', '--heads', repoUrl])

    let result = new GitLsRemote()

    const tagPrefix = 'refs/tags/'
    const tagSuffix = '^{}'
    const branchPrefix = 'refs/heads/'

    for (let line of (await lsRemote).split('\n')) {
      if (line.length === 0) {
        continue
      }
      let split = line.split('\t')
      assert(split.length == 2, line)
      let commit = split[0]
      let desc = split[1]

      if (desc.startsWith(tagPrefix)) {
        if (!desc.endsWith(tagSuffix)) {
          continue
        }
        result.tags.set(desc.slice(tagPrefix.length, -tagSuffix.length), commit)
      } else {
        assert(desc.startsWith(branchPrefix), line)
        result.branches.set(desc, commit)
      }
    }

    return result
  }

  public getTagsForCommit(commit: string) {
    return getKeysForCommit(this.tags, commit)
  }

  public getBranchesForCommit(commit: string) {
    return getKeysForCommit(this.branches, commit)
  }
}

export async function spawnGit(repoPath: string, args: string[], isStderrLineAllowed?: (s: string) => boolean) {
  return await spawnAsync('git', ['-C', repoPath, ...args], isStderrLineAllowed)
}

export async function spawnGitNoOut(repoPath: string, args: string[], isStderrLineAllowed?: (s: string) => boolean) {
  return await spawnAsyncNoOut('git', ['-C', repoPath, ...args], isStderrLineAllowed)
}

function getKeysForCommit(map: Map<string, string>, value: string) {
  return Array.from(map.entries())
    .filter(entry => entry[1].startsWith(value))
    .map(entry => entry[0])
}

export function isFullCommitHash(s: string) {
  return s.length === 40 && s.match(/^[0-9a-f]{40}$/) !== null
}

export function assertIsFullCommitHash(s: string) {
  if (!isFullCommitHash(s)) {
    throw new Error('expected full commit hash, got ' + s)
  }
}
