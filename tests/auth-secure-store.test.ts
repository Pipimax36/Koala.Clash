import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createSecureAuthStore } from '../src/main/auth/secure-store'
import type { AuthVault } from '../src/main/auth/contracts'

const vault: AuthVault = {
  version: 2,
  session: {
    accessToken: 'private-access-token-fixture',
    expiresAt: 2_100_000_000_000,
    user: { id: 'provider-subject', name: 'Customer' }
  }
}
const pendingVault: AuthVault = {
  version: 2,
  pending: {
    state: 's'.repeat(43),
    codeVerifier: 'v'.repeat(43),
    nonce: 'n'.repeat(43),
    expiresAt: 2_000_000_000_000
  }
}

function fakeCrypto() {
  const values = new Map<string, string>()
  let available = true
  let failEncryption = false
  return {
    isAvailable: () => available,
    encrypt(value: string): Buffer {
      if (failEncryption) throw new Error('Encryption failed')
      const encrypted = randomBytes(48)
      values.set(encrypted.toString('hex'), value)
      return encrypted
    },
    decrypt(value: Buffer): string {
      const decrypted = values.get(value.toString('hex'))
      if (decrypted === undefined) throw new Error('Decryption failed')
      return decrypted
    },
    setAvailable: (value: boolean) => {
      available = value
    },
    setFailEncryption: (value: boolean) => {
      failEncryption = value
    }
  }
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'koala-auth-store-'))
  const filePath = path.join(directory, 'auth', 'session.enc')
  const crypto = fakeCrypto()
  return {
    directory,
    filePath,
    crypto,
    store: createSecureAuthStore(filePath, crypto),
    cleanup: () => rm(directory, { recursive: true, force: true })
  }
}

test('credentials survive reopening with only encrypted bytes in a private file', async () => {
  const f = await fixture()
  try {
    assert.equal(await f.store.load(), null)
    assert.equal(await f.store.save(vault), true)
    assert.deepEqual(await createSecureAuthStore(f.filePath, f.crypto).load(), vault)
    const stored = await readFile(f.filePath, 'utf8')
    for (const secret of [vault.session!.accessToken, vault.session!.user.id]) {
      assert.equal(stored.includes(secret), false)
      assert.equal(stored.includes(Buffer.from(secret).toString('base64')), false)
    }
    if (process.platform !== 'win32') {
      assert.equal((await stat(f.filePath)).mode & 0o777, 0o600)
      assert.equal((await stat(path.dirname(f.filePath))).mode & 0o777, 0o700)
    }
  } finally {
    await f.cleanup()
  }
})

test('unavailable encryption preserves existing encrypted credentials without writing a replacement', async () => {
  const f = await fixture()
  try {
    await f.store.save(vault)
    const original = await readFile(f.filePath)
    f.crypto.setAvailable(false)
    await assert.rejects(f.store.load())
    assert.equal(await f.store.save(pendingVault), false)
    assert.deepEqual(await readFile(f.filePath), original)
    f.crypto.setAvailable(true)
    assert.deepEqual(await f.store.load(), vault)
  } finally {
    await f.cleanup()
  }
})

test('an encryption failure preserves the old encrypted file and never saves the replacement', async () => {
  const f = await fixture()
  try {
    await f.store.save(vault)
    const original = await readFile(f.filePath)
    f.crypto.setFailEncryption(true)
    assert.equal(await f.store.save(pendingVault), false)
    assert.deepEqual(await readFile(f.filePath), original)
    assert.deepEqual(await f.store.load(), vault)
  } finally {
    await f.cleanup()
  }
})

test('empty-vault deletion never asks the keychain for access', async () => {
  const f = await fixture()
  try {
    await f.store.save(vault)
    assert.equal(await f.store.save({ version: 2 }), true)
    assert.equal(await f.store.load(), null)
    await f.store.save(vault)
    const locked = createSecureAuthStore(f.filePath, {
      ...f.crypto,
      isAvailable: () => assert.fail('deletion must not access the keychain')
    })
    assert.equal(await locked.save({ version: 2 }), true)
    assert.equal(await locked.load(), null)
  } finally {
    await f.cleanup()
  }
})

test('corrupt envelopes and invalid decrypted vaults are rejected', async () => {
  const f = await fixture()
  try {
    await f.store.save(vault)
    const stored = await readFile(f.filePath, 'utf8')
    const invalidPayloads = [
      '',
      JSON.stringify(vault),
      stored + '!',
      stored.replace('v2:', 'v1:'),
      stored.slice(0, -4)
    ]
    for (const invalid of invalidPayloads) {
      await writeFile(f.filePath, invalid)
      await assert.rejects(f.store.load())
    }

    await writeFile(f.filePath, stored)
    const invalidVaults = [
      '{',
      'null',
      JSON.stringify({ version: 1, session: vault.session }),
      JSON.stringify({ ...pendingVault, session: vault.session }),
      JSON.stringify({ version: 2, pending: { ...pendingVault.pending, nonce: '' } }),
      JSON.stringify({ version: 2, session: { ...vault.session, user: { id: '' } } }),
      JSON.stringify({ version: 2, session: { ...vault.session, idToken: 'invalid' } }),
      JSON.stringify({
        version: 2,
        session: { ...vault.session, idToken: 'x'.repeat(16_384) + '.b.c' }
      }),
      JSON.stringify({ version: 1, refresh: { token: '', expiresAt: 1 } }),
      JSON.stringify({ version: 1, pending: { state: 'state', expiresAt: 1 } }),
      JSON.stringify({ version: 1, refresh: { token: 'token', expiresAt: 'tomorrow' } })
    ]
    for (const invalid of invalidVaults) {
      const store = createSecureAuthStore(f.filePath, { ...f.crypto, decrypt: () => invalid })
      await assert.rejects(store.load())
    }
  } finally {
    await f.cleanup()
  }
})

test('oversized files are rejected before decryption and oversized saves are refused', async () => {
  const f = await fixture()
  try {
    await f.store.save(vault)
    const stored = await readFile(f.filePath, 'utf8')
    await writeFile(f.filePath, stored + 'A'.repeat(64 * 1024))
    let decrypted = false
    const store = createSecureAuthStore(f.filePath, {
      ...f.crypto,
      decrypt: () => {
        decrypted = true
        return JSON.stringify(vault)
      }
    })
    await assert.rejects(store.load())
    assert.equal(decrypted, false)
    await assert.rejects(
      f.store.save({
        version: 2,
        session: { ...vault.session!, accessToken: 'x'.repeat(16 * 1024) }
      })
    )
  } finally {
    await f.cleanup()
  }
})

test('updates replace the complete file atomically and leave no temporary credentials', async () => {
  const f = await fixture()
  try {
    await f.store.save(vault)
    const previous = await open(f.filePath, 'r')
    try {
      const original = await readFile(f.filePath)
      const replacement: AuthVault = {
        version: 2,
        session: { ...vault.session!, accessToken: 'replacement-access-token' }
      }
      await f.store.save(replacement)
      assert.deepEqual(await previous.readFile(), original)
      assert.deepEqual(await f.store.load(), replacement)
      assert.deepEqual(await readdir(path.dirname(f.filePath)), ['session.enc'])
    } finally {
      await previous.close()
    }
  } finally {
    await f.cleanup()
  }
})

test('credential cleanup failures are reported rather than treated as logout success', async () => {
  const f = await fixture()
  try {
    await mkdir(f.filePath, { recursive: true })
    f.crypto.setAvailable(false)
    await assert.rejects(f.store.save({ version: 2 }))
  } finally {
    await f.cleanup()
  }
})

test('a logout queued behind a save cannot leave a previous access token on disk', async () => {
  const f = await fixture()
  try {
    const saving = f.store.save(vault)
    const clearing = f.store.save({ version: 2 })
    await Promise.all([saving, clearing])
    assert.equal(await f.store.load(), null)
  } finally {
    await f.cleanup()
  }
})

test('a failed replacement cleans temporary credentials and does not prevent a later save', async () => {
  const f = await fixture()
  try {
    await mkdir(f.filePath, { recursive: true })
    await writeFile(path.join(f.filePath, 'obstruction'), 'fixture')
    await assert.rejects(f.store.save(vault))
    assert.deepEqual(await readdir(path.dirname(f.filePath)), ['session.enc'])
    await rm(f.filePath, { recursive: true })
    assert.equal(await f.store.save(vault), true)
    assert.deepEqual(await f.store.load(), vault)
  } finally {
    await f.cleanup()
  }
})

test('pending nonce and verifier are encrypted and preserved across reopening', async () => {
  const f = await fixture()
  try {
    await f.store.save(pendingVault)
    assert.deepEqual(await createSecureAuthStore(f.filePath, f.crypto).load(), pendingVault)
    const stored = await readFile(f.filePath, 'utf8')
    for (const secret of [pendingVault.pending!.nonce, pendingVault.pending!.codeVerifier]) {
      assert.equal(stored.includes(secret), false)
      assert.equal(stored.includes(Buffer.from(secret).toString('base64')), false)
    }
  } finally {
    await f.cleanup()
  }
})
