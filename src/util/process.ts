import assert from 'assert'
import child_process, { SpawnOptions } from 'child_process'
import { promises as fs } from 'fs'
import { FileHandle } from 'fs/promises'
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
  let stdout = await spawnAsync(command, args, isStderrLineAllowed, stdinData)
  return stdout
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

export interface SpawnCmd {
  command: string
  args: ReadonlyArray<string>
  isStderrLineAllowed?: (s: string) => boolean
  stdinData?: Buffer
  stdinFileSource?: string
  stdoutFileSink?: string
  spawnOpts?: SpawnOptions
  handleStdoutBuffer?: (buf: Buffer) => void
  allowedExitCodes?: number[]
}

// Returns stdout. If there's stderr output, all lines of it should pass the isStderrLineAllowed check
export async function spawnAsync2(cmd: SpawnCmd) {
  let spawnOpts = cmd.spawnOpts ?? {} as SpawnOptions
  let fileHandles: FileHandle[] = []
  if (cmd.stdinFileSource !== undefined) {
    let fh = await fs.open(cmd.stdinFileSource, 'r')
    fileHandles.push(fh)
    spawnOpts.stdio = [fh.fd, 'pipe', 'pipe']
  }
  if (cmd.stdoutFileSink !== undefined) {
    let stdio = spawnOpts.stdio ?? ['pipe', 'pipe', 'pipe']
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

  let promise = new Promise((resolve, reject) => {
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
      let stderr = ''

      if (stderrBufs.length > 0) {
        stderr = Buffer.concat(stderrBufs).toString()
      }

      let allowedExitCodes = cmd.allowedExitCodes ?? [0]

      if (code !== null && allowedExitCodes.includes(code)) {
        if (stderr.length > 0) {
          if (cmd.isStderrLineAllowed === undefined) {
            reject(new Error('unexpected stderr ' + stderr))
          } else {
            for (let line of stderr.split('\n')) {
              if (line.length > 0 && !cmd.isStderrLineAllowed(line)) {
                reject(new Error('unexpected stderr line ' + line))
              }
            }
          }
        }
        resolve(Buffer.concat(stdoutBufs))
      } else {
        reject(new Error(proc.spawnargs + ' returned ' + code + (stderr.length > 0 ? ', stderr: ' + stderr : '')))
      }
    })
  })

  return promise as Promise<Buffer>
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
