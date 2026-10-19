import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config'
import { PROOF_CODE_LENGTH } from '../constants/task'

const CODE_PURPOSE = 'arrival-code'
const CODE_MODULUS = 10 ** PROOF_CODE_LENGTH

// The code the victim shows the volunteer on arrival. It is worked out from the request and the task, so it
// is never stored, the volunteer cannot see it anywhere, and a new task on the same request gets a new one.
// HMAC with the server's secret means nobody can compute it without the server.
export const arrivalCode = (sosId: string, taskId: string) => {
  const digest = createHmac('sha256', config.jwt.secret)
    .update(`${CODE_PURPOSE}:${sosId}:${taskId}`)
    .digest()
  return String(digest.readUInt32BE(0) % CODE_MODULUS).padStart(PROOF_CODE_LENGTH, '0')
}

export const codeMatches = (expected: string, given: string) => {
  const expectedBytes = Buffer.from(expected)
  const givenBytes = Buffer.from(given)
  return expectedBytes.length === givenBytes.length && timingSafeEqual(expectedBytes, givenBytes)
}
