import { createHash, randomBytes } from 'node:crypto'

const RESET_TOKEN_BYTES = 32

// The raw token goes in the emailed link; only its SHA-256 hash is stored, so a database leak
// can't be used to reset anyone's password. (SHA-256 rather than bcrypt: the token is already
// 256 bits of randomness, so there is nothing to brute-force.)
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export const generateResetToken = () => {
  const token = randomBytes(RESET_TOKEN_BYTES).toString('hex')
  return { token, hashedToken: hashToken(token) }
}
