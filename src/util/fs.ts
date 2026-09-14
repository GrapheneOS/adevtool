import { promises as fs } from 'fs'
import path from 'path'

export const TMP_PREFIX = 'adevtool-'

// https://stackoverflow.com/a/45130990
export async function* listFilesRecursive(dir: string): AsyncGenerator<string> {
  const dirents = await fs.readdir(dir, { withFileTypes: true })
  for (const dirent of dirents) {
    const res = path.resolve(dir, dirent.name)
    if (dirent.isDirectory()) {
      yield* listFilesRecursive(res)
    } else if (dirent.isFile() || dirent.isSymbolicLink()) {
      yield res
    }
  }
}

export async function removeEmptyDirsRecursive(dir: string, onDirDeleted: (dirPath: string) => void) {
  for (let de of await fs.readdir(dir, { withFileTypes: true })) {
    if (!de.isDirectory()) {
      continue
    }
    let childDir = path.resolve(dir, de.name)
    await removeEmptyDirsRecursive(childDir, onDirDeleted)
    try {
      await fs.rmdir(childDir)
      onDirDeleted(childDir)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
        throw e
      }
    }
  }
}

export async function exists(path: string) {
  try {
    await fs.access(path)
    return true
  } catch {
    // Doesn't exist or can't read
    return false
  }
}

export async function maybeStat(path: string) {
  try {
    return await fs.stat(path)
  } catch {
    return null
  }
}

export async function isFile(path: string) {
  return (await maybeStat(path))?.isFile() ?? false
}

export async function isDirectory(path: string) {
  return (await maybeStat(path))?.isDirectory() ?? false
}

export async function readFile(path: string) {
  return await fs.readFile(path, { encoding: 'utf8' })
}

export async function mkdirAndWriteFile(dirPath: string, fileName: string, content: string | Buffer) {
  await fs.mkdir(dirPath, { recursive: true })
  await fs.writeFile(path.join(dirPath, fileName), content)
}
