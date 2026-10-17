import { z } from 'zod'

// Express 5 parses a query string with Node's `querystring`, which does not understand brackets: `?status[]=a`
// arrives as a key literally named "status[]". Call this on `req.query` before a schema parses it. It:
//   - strips the `[]` from key names, so `status[]=a&status[]=b` and `status=a&status=b` are the same;
//   - drops keys whose value is empty (`?q=&status=`), so a cleared filter box means "no filter", not a 400.
export const normalizeQuery = (query: Record<string, unknown>): Record<string, unknown> => {
  const normalized: Record<string, unknown> = {}
  for (const [rawKey, value] of Object.entries(query)) {
    const key = rawKey.endsWith('[]') ? rawKey.slice(0, -2) : rawKey
    if (value === '' || (Array.isArray(value) && value.every((item) => item === ''))) continue
    const existing = normalized[key]
    normalized[key] =
      existing === undefined ? value : [existing, value].flat().filter((item) => item !== '')
  }
  return normalized
}

const toList = (value: unknown) => {
  if (value === undefined) return undefined
  const items = Array.isArray(value) ? value : [value]
  // "pending,assigned" is accepted too, so a client may send one parameter.
  return items.flatMap((item) => (typeof item === 'string' ? item.split(',') : [item]))
}

// An optional "any of these" filter: one value, a repeated parameter or a comma-separated list, each
// checked against `item`. Duplicates collapse. `max` caps the list so a query can't be padded.
export const queryList = <T extends z.ZodType>(item: T, max: number) =>
  z
    .preprocess(
      toList,
      z
        .array(item)
        .min(1)
        .max(max)
        .transform((values) => [...new Set(values)] as z.output<T>[]),
    )
    .optional()
