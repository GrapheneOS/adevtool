import { SmartBuffer } from 'smart-buffer'

export abstract class FastbootPack {
  readonly version: number
  readonly packVersion: string
  readonly slotType: number
  readonly totalEntries: number
  readonly totalSize: number

  readonly entries: FbpkEntry[] = []

  static parse(buffer: Buffer) {
    let b = SmartBuffer.fromBuffer(buffer)
    let magic = b.readString(4)
    if (magic !== 'FBPK') {
      throw new Error('unknown magic: ' + magic)
    }
    let version = u32(b)
    let res: FastbootPack
    switch (version) {
      case 1:
        res = new FastbootPackV1(b)
        break
      case 2:
        res = new FastbootPackV2(b)
        break
      default:
        throw new Error('unsupported version: ' + version)
    }
    return res
  }
}

export class FastbootPackV2 extends FastbootPack {
  readonly headerSize: number
  readonly entryHeaderSize: number
  readonly platform: string
  readonly dataAlign: number

  constructor(b: SmartBuffer) {
    super()
    // field names were copied from https://source.android.com/static/docs/core/architecture/bootloader/tools/pixel/fw_unpack/fbpack.py
    this.version = 2
    this.headerSize = u32(b)
    this.entryHeaderSize = u32(b)
    this.platform = str(b, 16)
    this.packVersion = str(b, 64)
    this.slotType = u32(b)
    this.dataAlign = u32(b)
    this.totalEntries = u32(b)
    this.totalSize = u32(b)

    if (this.totalSize !== b.length) {
      throw new Error(`totalSize mismatch: expected ${b.length}, got ${this.totalSize}`)
    }

    if (this.headerSize !== b.readOffset) {
      throw new Error(`headerSize mismatch: expected ${b.readOffset}, got ${this.headerSize}`)
    }

    for (let i = 0; i < this.totalEntries; ++i) {
      let off = b.readOffset
      this.entries.push(new FbpkEntryV2(b))
      let entryHeaderSize = b.readOffset - off
      if (entryHeaderSize !== this.entryHeaderSize) {
        throw new Error(`entryHeaderSize mismatch: expected ${this.entryHeaderSize}, got ${entryHeaderSize}`)
      }
    }
  }
}

export class FastbootPackV1 extends FastbootPack {
  constructor(b: SmartBuffer) {
    super()
    this.version = 1
    this.packVersion = str(b, 64)
    this.slotType = u32(b)
    this.totalEntries = u32(b)
    this.totalSize = u32(b)

    if (this.totalSize !== b.length) {
      throw new Error(`totalSize mismatch: expected ${b.length}, got ${this.totalSize}`)
    }

    for (let i = 0; i < this.totalEntries; ++i) {
      let e = new FbpkEntryV1(b)
      this.entries.push(e)
      if (e.nextEntryHeader < b.length) {
        b.readOffset = e.nextEntryHeader
      } else {
        if (i !== this.totalEntries - 1) {
          throw new Error(`unexpected next offset: ${e.nextEntryHeader}, packSize: ${b.length},
            entryIdx: ${i}, totalEntries: ${this.totalEntries}`)
        }
      }
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export enum EntryType {
  PartitionTable = 0,
  PartitionData = 1,
  SideloadData = 2,
}

export abstract class FbpkEntry {
  readonly type: number
  readonly name: string
  readonly size: number
  // 0 if absent. Some partitions don't verify against this value, not clear why. They are exactly
  // the same as partitions in OTA images. Perhaps they use a different checksum.
  readonly maybeCrc32: number

  abstract readContents(packBuf): Buffer
}

export class FbpkEntryV2 extends FbpkEntry {
  readonly product: string
  readonly offset: number
  readonly slotted: number

  constructor(b: SmartBuffer) {
    super()
    // field names copied from https://source.android.com/static/docs/core/architecture/bootloader/tools/pixel/fw_unpack/fbpack.py
    this.type = u32(b)
    this.name = str(b, 36)
    this.product = str(b, 40)
    this.offset = u64(b)
    this.size = u64(b)
    this.slotted = u32(b)
    this.maybeCrc32 = u32(b)
  }

  readContents(packBuf: Buffer) {
    return packBuf.subarray(this.offset, this.offset + this.size)
  }
}

export class FbpkEntryV1 extends FbpkEntry {
  readonly start: number
  readonly nextEntryHeader: number
  readonly unknown1: number
  readonly unknown2: number

  constructor(b: SmartBuffer) {
    super()
    this.type = u32(b)
    this.name = str(b, 32)
    this.unknown1 = u32(b)
    if (this.unknown1 !== 0) {
      throw new Error('unexpected value of unknown1 ' + this.unknown1)
    }
    this.size = u32(b)
    this.unknown2 = u32(b)
    if (this.unknown2 !== 0) {
      throw new Error('unexpected value of unknown2: ' + this.unknown2)
    }
    this.nextEntryHeader = u32(b)
    this.maybeCrc32 = u32(b)
    this.start = b.readOffset
  }

  readContents(packBuf: Buffer) {
    return packBuf.subarray(this.start, this.start + this.size)
  }
}

function u32(b: SmartBuffer) {
  return b.readUInt32LE()
}

function u64(b: SmartBuffer) {
  let bigUint = b.readBigUInt64LE()
  if (bigUint > Number.MAX_SAFE_INTEGER) {
    throw new Error('bigUint is outside the bounds of safe integer: ' + bigUint)
  }
  return Number(bigUint)
}

function str(b: SmartBuffer, maxLen: number) {
  let s = b.readString(maxLen)
  let end = s.indexOf('\0')
  if (end >= 0) {
    return s.substring(0, end)
  }
  return s
}
