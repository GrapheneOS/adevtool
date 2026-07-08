export interface GservicesFlag {
  name: string
  value: string
}

/**
 * Serializes gservices flags for plaintext storage.
 *
 * The format is one "name value" row per line. Embedded newlines are escaped
 * so every flag remains a single line.
 */
export function serializeGservicesFlags(flags: GservicesFlag[]): string {
  return (
    flags.map(row => `${row.name} ${row.value.replaceAll('\n', '\\n')}`).join('\n') +
    (flags.length > 0 ? '\n' : '')
  )
}

export function parseGservicesFlags(text: string): GservicesFlag[] {
  let flagsByName = new Map<string, GservicesFlag>()
  for (let line of text.split(/\r?\n/)) {
    let row = line.trimStart()
    if (row.length === 0 || row.startsWith('#')) {
      continue
    }

    let nameEnd = firstWhitespaceIndex(row)
    if (nameEnd <= 0) {
      continue
    }

    let name = row.substring(0, nameEnd)
    flagsByName.set(name, {
      name,
      value: row.substring(nameEnd + 1),
    })
  }
  return Array.from(flagsByName.values()).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
}

function firstWhitespaceIndex(value: string) {
  for (let i = 0; i < value.length; ++i) {
    if (/\s/.test(value[i])) {
      return i
    }
  }
  return -1
}
