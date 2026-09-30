import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const source = readFileSync(new URL('../build/pkg-scripts/postinstall', import.meta.url), 'utf8')

function withFixture(
  run: (fixture: {
    appPath: string
    wrongPath: string
    makeApp: (appPath: string) => void
    invoke: (
      failCommand?: string,
      failTarget?: string
    ) => { status: number | null; commands: string[] }
  }) => void
) {
  const root = mkdtempSync(path.join(tmpdir(), 'koala-pkg-postinstall-'))
  const applications = path.join(root, 'Applications with spaces')
  const appPath = path.join(applications, 'Koala Clash.app')
  const wrongPath = path.join(applications, 'Koala Clash.localized', 'Koala Clash.app')
  const bin = path.join(root, 'bin')
  const commandLog = path.join(root, 'commands.log')
  const script = path.join(root, 'postinstall')

  try {
    mkdirSync(applications, { recursive: true })
    mkdirSync(bin)
    // Redirect only the install root so the real script can run without touching /Applications.
    assert.equal(source.match(/\/Applications/g)?.length, 3)
    writeFileSync(script, source.replaceAll('/Applications', applications))
    for (const command of ['chown', 'chmod']) {
      writeFileSync(
        path.join(bin, command),
        '#!/bin/sh\n' +
          'printf "%s\\t%s\\t%s\\n" "${0##*/}" "$1" "$2" >> "$COMMAND_LOG"\n' +
          'if [ "${0##*/}" = "$FAIL_COMMAND" ] && [ "$2" = "$FAIL_TARGET" ]; then exit 42; fi\n',
        { mode: 0o755 }
      )
    }

    run({
      appPath,
      wrongPath,
      makeApp: (target) => {
        const sidecar = path.join(target, 'Contents', 'Resources', 'sidecar')
        mkdirSync(sidecar, { recursive: true })
        writeFileSync(path.join(sidecar, 'mihomo'), '')
        writeFileSync(path.join(sidecar, 'mihomo-alpha'), '')
      },
      invoke: (failCommand = '', failTarget = '') => {
        rmSync(commandLog, { force: true })
        const result = spawnSync('/bin/sh', [script], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:/usr/bin:/bin`,
            COMMAND_LOG: commandLog,
            FAIL_COMMAND: failCommand,
            FAIL_TARGET: failTarget
          }
        })
        if (result.error) throw result.error
        return {
          status: result.status,
          commands: existsSync(commandLog)
            ? readFileSync(commandLog, 'utf8').trim().split('\n')
            : []
        }
      }
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('postinstall fails when the installed app is absent', () => {
  withFixture(({ invoke }) => {
    const result = invoke()
    assert.notEqual(result.status, 0)
    assert.deepEqual(result.commands, [])
  })
})

test('postinstall fails when chown or chmod fails', () => {
  for (const command of ['chown', 'chmod']) {
    withFixture(({ appPath, makeApp, invoke }) => {
      makeApp(appPath)
      const target = path.join(appPath, 'Contents', 'Resources', 'sidecar', 'mihomo')
      const result = invoke(command, target)
      assert.notEqual(result.status, 0, `${command} failure must fail installation`)
    })
  }
})

test('postinstall moves the localized app and applies both sidecar permissions', () => {
  withFixture(({ appPath, wrongPath, makeApp, invoke }) => {
    makeApp(wrongPath)
    const result = invoke()
    const sidecar = path.join(appPath, 'Contents', 'Resources', 'sidecar')
    assert.equal(result.status, 0)
    assert.equal(existsSync(appPath), true)
    assert.equal(existsSync(path.dirname(wrongPath)), false)
    assert.deepEqual(result.commands, [
      `chown\troot:admin\t${path.join(sidecar, 'mihomo')}`,
      `chown\troot:admin\t${path.join(sidecar, 'mihomo-alpha')}`,
      `chmod\t+s\t${path.join(sidecar, 'mihomo')}`,
      `chmod\t+s\t${path.join(sidecar, 'mihomo-alpha')}`
    ])
  })
})
