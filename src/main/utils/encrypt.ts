import { safeStorage } from 'electron'
import { t } from './i18n'

const ENCRYPTED_PREFIX = 'enc:'

export function encryptString(plainText: string): string {
  if (!plainText) return ''

  if (plainText.startsWith(ENCRYPTED_PREFIX)) {
    return plainText
  }

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable')
  }

  try {
    const buffer = safeStorage.encryptString(plainText)
    return ENCRYPTED_PREFIX + buffer.toString('base64')
  } catch {
    throw new Error('Unable to encrypt protected settings')
  }
}

export function decryptString(encryptedText: string): string {
  if (!encryptedText) return ''

  if (!encryptedText.startsWith(ENCRYPTED_PREFIX)) {
    throw new Error(t('error.invalidEncryptionFormat'))
  }

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable')
  }

  try {
    const base64Data = encryptedText.substring(ENCRYPTED_PREFIX.length)
    const buffer = Buffer.from(base64Data, 'base64')
    return safeStorage.decryptString(buffer)
  } catch {
    throw new Error('Unable to decrypt protected settings')
  }
}

export function isEncrypted(text: string): boolean {
  if (!text) return false
  return text.startsWith(ENCRYPTED_PREFIX)
}
