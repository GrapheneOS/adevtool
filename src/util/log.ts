import { confirm, select } from '@inquirer/prompts'
import assert from 'assert'
import { Mutex } from 'async-mutex'
import prettyMilliseconds from 'pretty-ms'

let statusLineIdSrc = 0
let statusLines = new Map<number, StatusLine>()

export class StatusLine implements Disposable {
  readonly id = statusLineIdSrc++
  private value: string = ''

  constructor(value: string) {
    assert(!statusLines.has(this.id))
    statusLines.set(this.id, this)
    this.set(value)
  }

  set(value: string) {
    if (value === this.value) {
      return
    }
    this.value = value
    updateStatusLines()
  }

  getValue(): string {
    return this.value
  }

  [Symbol.dispose](): void {
    assert(statusLines.has(this.id))
    statusLines.delete(this.id)
    updateStatusLines()
  }
}

let numStatusLines = 0

let prevStatusLineUpdate = 0
let hasPendingStatusLineUpdate = false

function updateStatusLines() {
  if (statusLines.size === 0) {
    currentStatus = null
    clearStatusLines()
  } else if (!hasPendingStatusLineUpdate) {
    let now = performance.now()
    let diff = now - prevStatusLineUpdate
    const updateInterval = 100
    if (diff >= updateInterval) {
      prevStatusLineUpdate = now
      clearStatusLines()
      let status = Array.from(statusLines.values())
        .map(line => line.getValue())
        .join('\n')
      if (isClearPending) {
        currentStatus = status
      } else {
        writeStatus(status)
      }
    } else {
      hasPendingStatusLineUpdate = true
      setTimeout(() => {
        hasPendingStatusLineUpdate = false
        updateStatusLines()
      }, updateInterval - diff)
    }
  }
}

let pendingWrites: (string | Buffer | Uint8Array)[] = []
let currentStatus: string | null = null

let isClearPending = false

function clearStatusLines() {
  if (numStatusLines == 0 || isClearPending) {
    return
  }

  isClearPending = true
  assert(numStatusLines >= 1)
  writeToOriginalStdout = true
  process.stdout.moveCursor(-process.stdout.columns, -(numStatusLines - 1), () => {
    writeToOriginalStdout = true
    process.stdout.clearScreenDown(() => {
      isClearPending = false
      if (pendingWrites.length > 0) {
        for (let w of pendingWrites) {
          write(w)
        }
        pendingWrites = []
      }
      if (currentStatus !== null) {
        writeStatus(currentStatus)
      } else {
        numStatusLines = 0
      }
    })
    writeToOriginalStdout = false
  })
  writeToOriginalStdout = true
}

function writeStatus(status: string) {
  if (process.stdout.getWindowSize === undefined) {
    origStdoutWrite(status + '\n')
    return
  }

  let width = process.stdout.getWindowSize()[0]
  let numLines = 0
  let lines = status.split('\n').filter(l => l.length > 0)
  let processedStatus: string | null = null
  if (lines.length > 0) {
    numLines = 1
    for (let line of lines) {
      numLines += Math.floor((line.length - 1) / width) + 1
    }
    processedStatus = '\n' + lines.join('\n')
    origStdoutWrite(processedStatus)
  }

  numStatusLines = numLines
  currentStatus = processedStatus
}

const origStdoutWrite = process.stdout.write.bind(process.stdout)

let writeToOriginalStdout = false

process.stdout.write = (chunk, encoding, callback) => {
  if (writeToOriginalStdout) {
    origStdoutWrite(chunk, encoding, callback)
    return
  }
  if (currentStatus !== null) {
    clearStatusLines()
  }
  write(chunk, callback)
}

function write(str: string | Buffer | Uint8Array, callback?: () => void) {
  if (isClearPending) {
    pendingWrites.push(str)
  } else {
    origStdoutWrite(str as any, undefined, callback)
  }
}

export function log(str: string | Buffer | Uint8Array) {
  if (currentStatus !== null) {
    clearStatusLines()
    write(str)
  } else {
    write(str)
  }
  write('\n')
}

export function markTime(): number {
  return performance.now()
}

export function logElapsedTime(start: number, prefix: string) {
  let duration = prettyMilliseconds(performance.now() - start)
  log(prefix + ' ' + duration)
}

const askMutex = new Mutex()

export async function askInner<T>(ioFn: () => Promise<T>) {
  return await askMutex.runExclusive(async () => {
    // sleeps are needed when multiple prompts are queued, otherwise terminal state gets corrupted
    await new Promise(resolve => setTimeout(resolve, 100))
    let res = await ioFn()
    await new Promise(resolve => setTimeout(resolve, 100))
    return res
  })
}

export async function pause(msg: string) {
  await askInner(async () => {
    await select({
      message: msg,
      choices: ['Proceed'],
    })
  })
}

export async function askConfirm(msg: string) {
  return await askInner(async () => {
    return confirm({ message: msg })
  })
}
