import assert from 'assert'
import child_process, { IOType, SpawnOptions } from 'child_process'
import { promises as fs } from 'fs'
import { FileHandle } from 'fs/promises'
import { maybePlural } from './cli'
import { assertNonNull } from './data'

export async function spawnAsyncNoOut(
  command: string,
  args: ReadonlyArray<string>,
  isStderrLineAllowed?: (s: string) => boolean,
) {
  let stdout = await spawnAsync(command, args, isStderrLineAllowed)
  assert(stdout.length === 0, `unexpected stdout for ${command} ${args}: ${stdout}`)
}

export async function spawnAsyncStdin(
  command: string,
  args: ReadonlyArray<string>,
  stdinData: Buffer,
  isStderrLineAllowed?: (s: string) => boolean,
) {
  return await spawnAsync(command, args, isStderrLineAllowed, stdinData)
}

export async function spawnAsync(
  command: string,
  args: ReadonlyArray<string>,
  isStderrLineAllowed?: (s: string) => boolean,
  stdinData?: Buffer,
  allowedExitCodes: number[] = [0],
) {
  return (await spawnAsync2({ command, args, isStderrLineAllowed, stdinData, allowedExitCodes })).toString()
}

export interface BaseSpawnCmd {
  command: string
  args: ReadonlyArray<string>
  stdinData?: Buffer
  stdinFileSource?: string
  stdoutFileSink?: string
  spawnOpts?: SpawnOptions
  handleStdoutBuffer?: (buf: Buffer) => void
}

export interface SpawnCmd extends BaseSpawnCmd {
  isStderrLineAllowed?: (s: string) => boolean
  allowedExitCodes?: number[]
}

export interface SpawnResult {
  readonly spawnargs: string[]
  readonly exitCode: number
  readonly stdout: Buffer<ArrayBuffer>
  readonly stderr: Buffer<ArrayBuffer>
}

// Returns stdout. If there's stderr output, all lines of it should pass the isStderrLineAllowed check
export async function spawnAsync2(cmd: SpawnCmd) {
  let res = await spawnAsyncUnchecked(cmd)

  let allowedExitCodes = cmd.allowedExitCodes ?? [0]
  if (!allowedExitCodes.includes(res.exitCode)) {
    throw new Error(
      spawnargsStr(res.spawnargs) +
        ' returned ' +
        res.exitCode +
        (res.stderr.length > 0 ? ', stderr: ' + res.stderr.toString() : ''),
    )
  }

  if (res.stderr.length === 0) {
    return res.stdout
  }

  let stderr = res.stderr.toString()
  let isStderrLineAllowed = cmd.isStderrLineAllowed
  if (isStderrLineAllowed === undefined) {
    throw new Error(spawnargsStr(res.spawnargs) + ': unexpected stderr ' + stderr)
  }
  let unexpectedLines = stderr.split('\n').filter(line => line.length !== 0 && !isStderrLineAllowed(line))
  if (unexpectedLines.length > 0) {
    throw new Error(
      spawnargsStr(res.spawnargs) +
        `: unexpected stderr line${maybePlural(unexpectedLines)}:\n` +
        unexpectedLines.join('\n'),
    )
  }
  return res.stdout
}

export async function spawnAsyncUnchecked(cmd: BaseSpawnCmd) {
  let spawnOpts = cmd.spawnOpts ?? ({} as SpawnOptions)
  let fileHandles: FileHandle[] = []
  if (cmd.stdinFileSource !== undefined) {
    let fh = await fs.open(cmd.stdinFileSource, 'r')
    fileHandles.push(fh)
    spawnOpts.stdio = [fh.fd, 'pipe', 'pipe']
  }
  if (cmd.stdoutFileSink !== undefined) {
    assert(spawnOpts.stdio === undefined || Array.isArray(spawnOpts.stdio))
    let stdio = (spawnOpts.stdio as Array<IOType | number>) ?? ['pipe', 'pipe', 'pipe']
    let fh = await fs.open(cmd.stdoutFileSink, 'w')
    fileHandles.push(fh)
    stdio[1] = fh.fd
    spawnOpts.stdio = stdio
  }
  let proc = child_process.spawn(cmd.command, cmd.args, spawnOpts)

  if (cmd.stdinData !== undefined) {
    let stdin = assertNonNull(proc.stdin)
    stdin.write(cmd.stdinData)
    stdin.end()
  }

  return new Promise<SpawnResult>((resolve, reject) => {
    proc.on('error', err => reject(err))

    let stdoutBufs: Buffer[] = []
    let stderrBufs: Buffer[] = []

    proc.on('error', reject)

    let handleStdoutBuffer =
      cmd.handleStdoutBuffer ??
      (buf => {
        stdoutBufs.push(buf)
      })

    proc.stdout?.on('data', data => {
      handleStdoutBuffer(data)
    })
    proc.stderr?.on('data', data => {
      stderrBufs.push(data)
    })

    proc.on('close', code => {
      for (let fd of fileHandles) {
        fd.close()
      }
      if (code === null) {
        reject(new Error(spawnargsStr(proc.spawnargs) + ' returned a null exit code'))
      } else {
        resolve({
          spawnargs: proc.spawnargs,
          exitCode: code,
          stdout: Buffer.concat(stdoutBufs),
          stderr: Buffer.concat(stderrBufs),
        })
      }
    })
  })
}

export function lastLine(buf: Buffer) {
  let str = buf.toString()
  let end = -1
  for (let i = buf.length - 1; i >= 0; --i) {
    if (str.charAt(i) !== '\n') {
      end = i + 1
      break
    }
  }
  let start = 0
  if (end > 0) {
    for (let i = end - 1; i >= 0; --i) {
      if (str.charAt(i) === '\n') {
        start = i + 1
        break
      }
    }
    return str.slice(start, end)
  }
  return ''
}

function spawnargsStr(spawnargs: string[]) {
  return "'" + spawnargs.join(' ') + "'"
}
