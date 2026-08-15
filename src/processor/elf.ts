import { promises as fs } from 'fs'
import path from 'path'
import asyncPool from 'tiny-async-pool'

import { BlobEntry } from '../blobs/entry'
import { PartPath } from '../blobs/file-list'
import { OS_CHECKOUT_DIR } from '../config/paths'
import { mapGet } from '../util/data'
import { Partition, PathResolver } from '../util/partitions'
import { spawnAsync, spawnAsyncStdin } from '../util/process'

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const LLVM_BINUTILS_DIR = path.join(OS_CHECKOUT_DIR, 'prebuilts/clang/host/linux-x86/llvm-binutils-stable')
const LLVM_READOBJ = path.join(LLVM_BINUTILS_DIR, 'llvm-readobj')
const LLVM_CXXFILT = path.join(LLVM_BINUTILS_DIR, 'llvm-cxxfilt')
const READOBJ_BATCH_SIZE = 32

interface ElfSymbol {
  name: string
  version: string
}

interface ElfInfo {
  elfClass: number
  machine: number
  type: string
  soname: string
  needed: string[]
  imports: ElfSymbol[]
  // symbol name -> versions it is defined with ('' for unversioned)
  exports: Map<string, Set<string>>
}

// llvm-readobj --elf-output-style=JSON sturcture
interface ReadObjSymbol {
  Symbol: {
    Name: { Name: string }
    Binding: { Name: string }
    Other: { Value: number }
    Section: { Name: string }
  }
}

interface ReadObjFile {
  FileSummary: { LoadName: string }
  ElfHeader: {
    Ident: { Class: { Value: number } }
    Machine: { Value: number }
    Type: string
  }
  NeededLibraries?: string[]
  DynamicSymbols?: ReadObjSymbol[]
}

interface Candidate {
  partPath: PartPath
  filePath: string
}

interface ElfNode extends Candidate {
  info: ElfInfo
}

interface ElfClosure {
  nodes: ElfNode[]
  // DT_NEEDED name -> the library the linker would load for it
  directProviders: Map<string, ElfNode>
}

interface MissingNeeded {
  name: string
  sourceProvider: ElfNode
}

interface MissingSymbol {
  symbol: ElfSymbol
  sourceProvider: ElfNode
  // stale same-soname lib present in the mixed image, shown as "mixed-image provider"
  targetProvider?: ElfNode
}

interface ElfIssues {
  root: ElfNode
  missingNeeded: MissingNeeded[]
  missingSymbols: MissingSymbol[]
}

class ElfParser {
  private cache = new Map<string, ElfInfo>()

  async read(filePaths: string[]): Promise<Map<string, ElfInfo>> {
    let uncachedPaths = Array.from(new Set(filePaths.filter(filePath => !this.cache.has(filePath))))

    for (let i = 0; i < uncachedPaths.length; i += READOBJ_BATCH_SIZE) {
      let paths = uncachedPaths.slice(i, i + READOBJ_BATCH_SIZE)
      let output: string
      try {
        output = await spawnAsync(LLVM_READOBJ, [
          '--elf-output-style=JSON',
          '--file-header',
          '--needed-libs',
          '--dyn-symbols',
          ...paths,
        ])
      } catch (e) {
        throw new Error(`failed to inspect ELF files: ${e instanceof Error ? e.message : e}`)
      }

      let records: ReadObjFile[]
      try {
        records = JSON.parse(output)
      } catch (e) {
        throw new Error(`failed to parse llvm-readobj output: ${e instanceof Error ? e.message : e}`)
      }
      if (!Array.isArray(records) || records.length !== paths.length) {
        throw new Error('unexpected llvm-readobj output')
      }

      for (let j = 0; j < paths.length; ++j) {
        this.cache.set(paths[j], parseReadObjFile(records[j], paths[j]))
      }
    }

    let infos = new Map<string, ElfInfo>()
    for (let filePath of filePaths) {
      infos.set(filePath, mapGet(this.cache, filePath))
    }
    return infos
  }
}

class ElfEnvironment {
  private candidateCache = new Map<string, Promise<Candidate[]>>()

  constructor(
    private resolver: PathResolver,
    private parser: ElfParser,
  ) {}

  async getClosure(root: ElfNode): Promise<ElfClosure> {
    let nodes = [root]
    let directProviders = new Map<string, ElfNode>()
    let seen = new Set([root.filePath])
    let frontier = [root]

    while (frontier.length > 0) {
      let requests = frontier.flatMap(consumer => consumer.info.needed.map(needed => ({ consumer, needed })))
      let resolvedRequests = await Promise.all(
        requests.map(async request => ({
          ...request,
          candidates: await this.getCandidates(request.consumer, request.needed),
        })),
      )
      let infoByPath = await this.parser.read(
        resolvedRequests.flatMap(request => request.candidates.map(candidate => candidate.filePath)),
      )
      let nextFrontier: ElfNode[] = []

      for (let { consumer, needed, candidates } of resolvedRequests) {
        let provider: ElfNode | undefined
        for (let candidate of candidates) {
          let info = mapGet(infoByPath, candidate.filePath)
          // match by DT_SONAME, not filename
          if (
            info.elfClass === consumer.info.elfClass &&
            info.machine === consumer.info.machine &&
            info.soname === needed
          ) {
            provider = { ...candidate, info }
            break
          }
        }
        if (provider === undefined) {
          continue
        }

        if (consumer === root) {
          directProviders.set(needed, provider)
        }
        if (!seen.has(provider.filePath)) {
          seen.add(provider.filePath)
          nodes.push(provider)
          nextFrontier.push(provider)
        }
      }
      frontier = nextFrontier
    }

    return { nodes, directProviders }
  }

  private getCandidates(consumer: ElfNode, needed: string) {
    let key = [consumer.partPath.partition, consumer.info.elfClass, needed].join('\0')
    let promise = this.candidateCache.get(key)
    if (promise === undefined) {
      promise = this.loadCandidates(consumer.partPath.partition, consumer.info.elfClass, needed)
      this.candidateCache.set(key, promise)
    }
    return promise
  }

  // Follows approximate linkerconfig namespace search order
  private async loadCandidates(partition: Partition, elfClass: number, needed: string) {
    let libDir = elfClass === 2 ? 'lib64' : 'lib'
    let partPaths: PartPath[] = []
    for (let candidatePartition of libraryPartitionOrder(partition)) {
      let relDir =
        candidatePartition === Partition.Recovery || candidatePartition === Partition.VendorRamdisk
          ? path.join('system', libDir)
          : libDir
      partPaths.push(new PartPath(candidatePartition, path.join(relDir, needed)))
      if (candidatePartition === Partition.System) {
        partPaths.push(new PartPath(candidatePartition, path.join(libDir, 'bootstrap', needed)))
      }
    }

    let resolved = await Promise.all(
      partPaths.map(async partPath => {
        let filePath = await getElfPath(partPath.resolve(this.resolver))
        return filePath === null ? null : { partPath, filePath }
      }),
    )
    let seen = new Set<string>()
    return resolved.filter((candidate): candidate is Candidate => {
      if (candidate === null || seen.has(candidate.filePath)) {
        return false
      }
      seen.add(candidate.filePath)
      return true
    })
  }
}

// Verify that ELFs overlaid from the backport build still link in the mixed target image,
// where their dependencies may resolve to older libraries.
// Its dependency closure is computed against backport image and against the mixed image,
// and DT_NEEDED entries / imported symbols satisfied only in the mixed one are reported.
export async function checkBackportedElfs(
  entries: BlobEntry[],
  targetResolver: PathResolver,
): Promise<string | null> {
  let overlay = targetResolver.overlay
  if (overlay === undefined) {
    return null
  }

  let selectedEntries = entries.filter(entry =>
    targetResolver.isOverlaid(entry.partPath.partition, entry.partPath.relPath),
  )
  let sourceResolver = new PathResolver(overlay.basePath, targetResolver.context)
  let resolved = new Array<Candidate | null>(selectedEntries.length).fill(null)
  let indexedEntries = selectedEntries.map((entry, i) => [i, entry.partPath] as const)
  await Array.fromAsync(
    asyncPool(READOBJ_BATCH_SIZE, indexedEntries, async ([i, partPath]) => {
      let filePath = await getElfPath(partPath.resolve(sourceResolver))
      resolved[i] = filePath === null ? null : { partPath, filePath }
    }),
  )
  let candidates = resolved.filter((candidate): candidate is Candidate => candidate !== null)
  let parser = new ElfParser()
  let infoByPath = await parser.read(candidates.map(candidate => candidate.filePath))
  let roots = candidates
    .map(candidate => ({ ...candidate, info: mapGet(infoByPath, candidate.filePath) }))
    .filter(root => root.info.type.startsWith('SharedObject') || root.info.type.startsWith('Executable'))

  let sourceEnvironment = new ElfEnvironment(sourceResolver, parser)
  let targetEnvironment = new ElfEnvironment(targetResolver, parser)
  let issues: ElfIssues[] = []

  for (let root of roots) {
    let sourceClosure = await sourceEnvironment.getClosure(root)
    let targetClosure = await targetEnvironment.getClosure(root)
    let missingNeeded: MissingNeeded[] = []
    for (let needed of root.info.needed) {
      let sourceProvider = sourceClosure.directProviders.get(needed)
      if (sourceProvider !== undefined && !targetClosure.directProviders.has(needed)) {
        missingNeeded.push({ name: needed, sourceProvider })
      }
    }

    let missingNeededProviderPaths = new Set(missingNeeded.map(missing => missing.sourceProvider.filePath))

    let missingSymbols: MissingSymbol[] = []
    for (let symbol of root.info.imports) {
      let sourceProvider = findSymbolProvider(sourceClosure.nodes, symbol)
      if (
        sourceProvider === undefined ||
        missingNeededProviderPaths.has(sourceProvider.filePath) ||
        findSymbolProvider(targetClosure.nodes, symbol) !== undefined
      ) {
        continue
      }
      missingSymbols.push({
        symbol,
        sourceProvider,
        targetProvider: targetClosure.nodes.find(node => node.info.soname === sourceProvider.info.soname),
      })
    }

    if (missingNeeded.length > 0 || missingSymbols.length > 0) {
      issues.push({ root, missingNeeded, missingSymbols })
    }
  }

  if (issues.length > 0) {
    return await formatIssues(issues)
  }
  return null
}

function parseReadObjFile(record: ReadObjFile, filePath: string): ElfInfo {
  if (record?.ElfHeader?.Ident?.Class === undefined || record.ElfHeader.Machine === undefined) {
    throw new Error('missing ELF header in llvm-readobj output for ' + filePath)
  }

  let imports = new Map<string, ElfSymbol>()
  let exports = new Map<string, Set<string>>()
  for (let entry of record.DynamicSymbols ?? []) {
    let symbol = entry.Symbol
    let parsedName = parseSymbolName(symbol.Name.Name)
    if (parsedName.name.length === 0) {
      continue
    }

    if (symbol.Section.Name === 'Undefined') {
      // weak undefined symbols are allowed to stay unresolved at runtime
      if (symbol.Binding.Name !== 'Weak') {
        imports.set(symbolKey(parsedName), parsedName)
      }
    } else if (symbol.Binding.Name !== 'Local' && !isHidden(symbol.Other.Value)) {
      let versions = exports.get(parsedName.name)
      if (versions === undefined) {
        versions = new Set<string>()
        exports.set(parsedName.name, versions)
      }
      versions.add(parsedName.version)
    }
  }

  // executables and libs without DT_SONAME are matched by filename instead
  let loadName = record.FileSummary?.LoadName
  return {
    elfClass: record.ElfHeader.Ident.Class.Value,
    machine: record.ElfHeader.Machine.Value,
    type: record.ElfHeader.Type,
    soname: loadName === undefined || loadName === '<Not found>' ? path.basename(filePath) : loadName,
    needed: record.NeededLibraries ?? [],
    imports: Array.from(imports.values()),
    exports,
  }
}

// x@LIBX references version LIBX; x@@LIBX defines the default version
function parseSymbolName(name: string): ElfSymbol {
  let versionIdx = name.lastIndexOf('@')
  if (versionIdx < 0) {
    return { name, version: '' }
  }
  let nameEnd = versionIdx > 0 && name[versionIdx - 1] === '@' ? versionIdx - 1 : versionIdx
  return { name: name.substring(0, nameEnd), version: name.substring(versionIdx + 1) }
}

// low bits of st_other:
// 1 = STV_INTERNAL,
// 2 = STV_HIDDEN;
// 3 = STV_PROTECTED stays exported
function isHidden(other: number) {
  let visibility = other & 0x3
  return visibility === 1 || visibility === 2
}

function symbolKey(symbol: ElfSymbol) {
  return symbol.name + '\0' + symbol.version
}

function findSymbolProvider(nodes: ElfNode[], symbol: ElfSymbol) {
  for (let node of nodes) {
    let versions = node.info.exports.get(symbol.name)
    // unversioned reference binds to any version; a versioned reference requires an exact match
    if (versions !== undefined && (symbol.version.length === 0 || versions.has(symbol.version))) {
      return node
    }
  }
  return undefined
}

function libraryPartitionOrder(partition: Partition): Partition[] {
  switch (partition) {
    case Partition.Vendor:
    case Partition.SystemExt:
    case Partition.Product:
      return [partition, Partition.System]
    default:
      return [partition]
  }
}

async function getElfPath(filePath: string) {
  let realPath: string
  try {
    realPath = await fs.realpath(filePath)
  } catch (e) {
    let code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ELOOP') {
      return null
    }
    throw e
  }

  let file = await fs.open(realPath, 'r')
  try {
    let magic = Buffer.alloc(ELF_MAGIC.length)
    let { bytesRead } = await file.read(magic, 0, magic.length, 0)
    return bytesRead === ELF_MAGIC.length && magic.equals(ELF_MAGIC) ? realPath : null
  } finally {
    await file.close()
  }
}

async function formatIssues(issues: ElfIssues[]) {
  let symbols = Array.from(
    new Set(issues.flatMap(issue => issue.missingSymbols.map(missing => missing.symbol.name))),
  )
  let demangled = new Map<string, string>()
  if (symbols.length > 0) {
    let output = await spawnAsyncStdin(LLVM_CXXFILT, [], Buffer.from(symbols.join('\n') + '\n'))
    let lines = output.trimEnd().split('\n')
    for (let i = 0; i < symbols.length; ++i) {
      demangled.set(symbols[i], lines[i] ?? symbols[i])
    }
  }

  let lines = ['ELF compatibility check failed:']
  for (let issue of issues) {
    lines.push(issue.root.partPath.asPseudoPath() + ':')
    for (let missing of issue.missingNeeded.toSorted((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`  missing DT_NEEDED: ${missing.name} (${missing.sourceProvider.partPath.asPseudoPath()})`)
    }

    let symbolGroups = new Map<string, MissingSymbol[]>()
    for (let missing of issue.missingSymbols) {
      let key = missing.sourceProvider.partPath.asPseudoPath()
      let group = symbolGroups.get(key)
      if (group === undefined) {
        group = []
        symbolGroups.set(key, group)
      }
      group.push(missing)
    }
    for (let [providerPath, missingSymbols] of Array.from(symbolGroups.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      let targetProvider = missingSymbols[0].targetProvider
      let targetPath = targetProvider?.partPath.asPseudoPath()
      let mixedProvider = targetPath !== undefined && targetPath !== providerPath ? ` (mixed image: ${targetPath})` : ''
      lines.push(`  unresolved symbols from ${providerPath}${mixedProvider}:`)
      for (let missing of missingSymbols.toSorted((a, b) => symbolKey(a.symbol).localeCompare(symbolKey(b.symbol)))) {
        let rawName = missing.symbol.name + (missing.symbol.version.length > 0 ? '@' + missing.symbol.version : '')
        let demangledName = demangled.get(missing.symbol.name) ?? missing.symbol.name
        lines.push(`    ${rawName}${demangledName === missing.symbol.name ? '' : ' (' + demangledName + ')'}`)
      }
    }
  }
  return lines.join('\n')
}
