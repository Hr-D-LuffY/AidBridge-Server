import { z } from 'zod'

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/

// A 24-hex-character MongoDB ObjectId, as a string. Use it for body fields and query params.
export const objectIdSchema = z.string().regex(OBJECT_ID_PATTERN, 'Must be a valid id')

// For any `/:id` route: parse req.params with this so a malformed id is a 400, not a cast error.
export const idParamSchema = z.object({ id: objectIdSchema })

// Body schema for PATCH/PUT endpoints. A plain z.object silently drops fields it doesn't know, so a
// request that only sends a field the caller may not edit (e.g. a victim sending `role`) turns
// into `{}` and fails with a misleading "provide at least one field". Rejecting unknown fields by
// name tells the caller what is wrong. `hint` says what they can edit or where to go instead.
export const updateBodySchema = <T extends z.ZodRawShape>(shape: T, hint?: string) =>
  z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `Cannot update: ${issue.keys.join(', ')}${hint ? `. ${hint}` : ''}`
        : undefined,
  })

// For update bodies: `.refine(...atLeastOneField)` rejects an empty update.
export const atLeastOneField = [
  (value: object) => Object.values(value).some((field) => field !== undefined),
  {
    message: 'Provide at least one field to update',
    // Skipped when the body already has a rejected field: that error says what's wrong.
    when: (payload: { issues: readonly unknown[] }) => payload.issues.length === 0,
  },
] as const
