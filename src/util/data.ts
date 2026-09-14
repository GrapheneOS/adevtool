import assert from 'assert'

export function setIntersection<Value>(a: Set<Value>, b: Set<Value>) {
  let set = new Set<Value>()
  for (let value of a) {
    if (b.has(value)) {
      set.add(value)
    }
  }
  return set
}

export function setDifference<Value>(a: Set<Value>, b: Set<Value>) {
  let set = new Set<Value>()
  for (let value of a) {
    if (!b.has(value)) {
      set.add(value)
    }
  }
  return set
}

export function updateMultiSet<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  let set = map.get(key)
  if (set === undefined) {
    set = new Set<V>()
    map.set(key, set)
  }
  if (set.has(value)) {
    return false
  }
  set.add(value)
  return true
}

export function updateMultiMap<K, V>(map: Map<K, V[]>, key: K, value: V) {
  let cur = map.get(key)
  if (cur === undefined) {
    map.set(key, [value])
  } else {
    cur.push(value)
  }
}

export function updateMultiMapObj<V>(map: Record<string, V[]>, key: string, value: V) {
  let cur = map[key]
  if (cur === undefined) {
    map[key] = [value]
  } else {
    cur.push(value)
  }
}

export function assertDefined<T>(o: T | undefined, message?: string): T {
  if (message !== undefined) {
    assert(o !== undefined, message)
  } else {
    if (o === undefined) {
      throw new Error('value is undefined')
    }
  }
  return o
}

export function assertNonNull<T>(o: T | null): T {
  if (o === null) {
    throw new Error('value is null')
  }
  return o
}

export function mapGet<K, V>(map: Map<K, V>, key: K) {
  let res = map.get(key)
  if (res === undefined) {
    throw new Error('no value for ' + key)
  }
  return res
}

export function mapSet<K, V>(map: Map<K, V>, key: K, val: V) {
  assert(!map.has(key), key as string)
  map.set(key, val)
}
export function objGet<V>(obj: Record<string, V>, key: string) {
  let res = obj[key]
  if (res == undefined) {
    throw new Error('no value for ' + key)
  }
  return res
}

export function objSet<V>(obj: Record<string, V>, key: string, val: V) {
  assert(obj[key] === undefined, key)
  obj[key] = val
}

export async function filterAsync<T>(arr: readonly T[], predicate: (value: T) => Promise<boolean>): Promise<T[]> {
  let bools = await Promise.all(arr.map(e => predicate(e)))
  return arr.filter((_, idx) => bools[idx])
}

export function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0
  }
  return a < b ? -1 : 1
}
