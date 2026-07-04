export function areArraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) {
    return false
  }

  return a.every((value, index) => value === b[index])
}

export function getFirst<T>(items: T[] | Set<T>): T | undefined {
  if (Array.isArray(items)) {
    return items[0]
  }

  for (const item of items) {
    return item
  }

  return undefined
}

export function removeItem<T>(items: T[], item: T): T[] {
  const index = items.indexOf(item)

  if (index === -1) {
    return items
  }

  return [...items.slice(0, index), ...items.slice(index + 1)]
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && Math.floor(value) === value
}
