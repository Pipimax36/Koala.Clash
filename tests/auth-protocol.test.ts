import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUTH_CALLBACK, AuthRequestError } from '../src/main/auth/contracts'
import { assertCurrentProtocolHandler } from '../src/main/auth/protocol'

const currentBundle = '/Build/Koala Clash.app'
const executablePath = `${currentBundle}/Contents/MacOS/Koala Clash`

function fixture() {
  const lookups: string[] = []
  const resolutions: string[] = []
  return {
    lookups,
    resolutions,
    options: {
      platform: 'darwin' as NodeJS.Platform,
      isPackaged: true,
      executablePath,
      getApplicationInfoForProtocol: async (url: string) => {
        lookups.push(url)
        return { path: currentBundle }
      },
      resolvePath: async (path: string) => {
        resolutions.push(path)
        return path
      }
    }
  }
}

test('accepts the running macOS bundle as the callback handler', async () => {
  const f = fixture()
  await assertCurrentProtocolHandler(f.options)
  assert.deepEqual(f.lookups, [AUTH_CALLBACK])
  assert.deepEqual(f.resolutions.sort(), [currentBundle, currentBundle])
})

test('compares canonical paths so aliases of the same application are accepted', async () => {
  const f = fixture()
  await assertCurrentProtocolHandler({
    ...f.options,
    getApplicationInfoForProtocol: async () => ({ path: '/Applications/Koala Clash.app' }),
    resolvePath: async () => '/Volumes/Apps/Koala Clash.app'
  })
})

test('rejects a different application copy with a controlled conflict reason', async () => {
  const f = fixture()
  await assert.rejects(
    assertCurrentProtocolHandler({
      ...f.options,
      getApplicationInfoForProtocol: async () => ({ path: '/Applications/Koala Clash.app' })
    }),
    (error: unknown) => {
      assert.ok(error instanceof AuthRequestError)
      assert.equal(error.reason, 'protocol-conflict')
      assert.equal(error.message, 'protocol-conflict')
      return true
    }
  )
})

test('handler lookup failures do not expose underlying diagnostics', async () => {
  const f = fixture()
  await assert.rejects(
    assertCurrentProtocolHandler({
      ...f.options,
      getApplicationInfoForProtocol: async () => {
        throw new Error('Private application path: /Users/private/Old Koala.app')
      }
    }),
    { message: 'protocol-unavailable' }
  )
  assert.deepEqual(f.resolutions, [])
})

test('missing or inaccessible application paths fail closed', async () => {
  for (const missing of [currentBundle, '/Applications/Koala Clash.app']) {
    const f = fixture()
    await assert.rejects(
      assertCurrentProtocolHandler({
        ...f.options,
        getApplicationInfoForProtocol: async () => ({ path: '/Applications/Koala Clash.app' }),
        resolvePath: async (path: string) => {
          if (path === missing) throw new Error(`ENOENT: ${path}`)
          return path
        }
      }),
      { message: 'protocol-unavailable' }
    )
  }
})

test('invalid application locations are unavailable rather than reported as another copy', async () => {
  const f = fixture()
  for (const handlerPath of ['', 'relative/Koala.app']) {
    await assert.rejects(
      assertCurrentProtocolHandler({
        ...f.options,
        getApplicationInfoForProtocol: async () => ({ path: handlerPath })
      }),
      { message: 'protocol-unavailable' }
    )
  }
  await assert.rejects(
    assertCurrentProtocolHandler({ ...f.options, executablePath: '/usr/local/bin/koala' }),
    { message: 'protocol-unavailable' }
  )
})

test('the macOS copy check does not query protocol handlers on other platforms or development runs', async () => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    const f = fixture()
    await assertCurrentProtocolHandler({
      ...f.options,
      platform,
      isPackaged: platform !== 'darwin',
      getApplicationInfoForProtocol: async () => {
        assert.fail('The macOS packaged-app check must be skipped')
      },
      resolvePath: async () => {
        assert.fail('No paths should be resolved')
      }
    })
  }
})
