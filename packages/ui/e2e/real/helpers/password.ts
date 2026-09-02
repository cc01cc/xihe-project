import { randomBytes } from 'node:crypto'

/**
 * Generate a random E2E password. Always 12+ characters and free of the
 * fixed weak password. Characters are drawn from an unambiguous
 * alphanumeric set (Crockford-friendly) to avoid backend regex
 * restrictions on punctuation.
 */
export function generateE2EPassword(length = 16): string {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  if (length < 12) {
    throw new Error('E2E passwords must be at least 12 characters long')
  }
  const bytes = randomBytes(length)
  let result = ''
  for (let i = 0; i < length; i += 1) {
    result += charset[bytes[i] % charset.length]
  }
  return result
}

export const E2E_DEFAULT_PASSWORD = generateE2EPassword()
