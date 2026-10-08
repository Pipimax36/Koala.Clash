import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import YAML from 'yaml'
import { resolveReleaseVersion } from '../scripts/release-version.mjs'

test('both accepted version inputs produce the same package version and release tag', () => {
  for (const input of ['1.4.2', 'v1.4.2']) {
    assert.deepEqual(resolveReleaseVersion(input, '1.4.1', 'abcdef0123'), {
      version: '1.4.2',
      tag: 'v1.4.2',
      prerelease: false
    })
  }
  assert.throws(() => resolveReleaseVersion('v1.4.2\nother=value', '1.4.1', 'abcdef0123'))
})

test('release notes and legacy metadata retain the real tag and project repository', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'koala-release-test-'))
  try {
    mkdirSync(path.join(fixture, 'src/shared'), { recursive: true })
    writeFileSync(
      path.join(fixture, 'src/shared/release-source.json'),
      readFileSync(new URL('../src/shared/release-source.json', import.meta.url))
    )
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ version: '1.4.2' }))
    writeFileSync(path.join(fixture, 'changelog.md'), '## 1.4.2\nFix updater\n')
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('../scripts/updater.mjs', import.meta.url))],
      {
        cwd: fixture,
        env: { ...process.env, RELEASE_TAG: 'v1.4.2', SKIP_CHANGELOG: '0' }
      }
    )
    const metadata = YAML.parse(readFileSync(path.join(fixture, 'latest.yml'), 'utf8'))
    assert.equal(metadata.version, '1.4.2')
    assert.equal(metadata.tag, 'v1.4.2')
    const notes = readFileSync(path.join(fixture, 'changelog.md'), 'utf8')
    assert.ok(
      notes.includes(
        'https://github.com/Pipimax36/Koalamo/releases/download/v1.4.2/Koala.Clash_arm64.pkg'
      )
    )
    assert.ok(!notes.includes('coolcoala/koala-clash'))
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('build and publish consume one release identity', () => {
  const workflow = YAML.parse(
    readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8')
  )
  assert.equal(
    workflow.jobs.release.steps.find((s: { name?: string }) => s.name === 'Publish Release').with
      .tag_name,
    '${{ needs.version.outputs.tag }}'
  )
  assert.equal(
    workflow.jobs.build.steps.find((s: { name?: string }) => s.name === 'Generate latest.yml').env
      .RELEASE_TAG,
    '${{ needs.version.outputs.tag }}'
  )
  assert.equal(workflow.jobs['pre-release'].if, "needs.version.outputs.prerelease == 'true'")
})

test('release builds require the login secret only in the main-process build step', () => {
  const workflow = YAML.parse(
    readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8')
  )
  const steps = workflow.jobs.build.steps
  const build = steps.find((step: { name?: string }) => step.name === 'Build')
  assert.equal(build.env.KOALA_REQUIRE_WHMCS_LOGIN, '1')
  assert.equal(build.env.KOALA_WHMCS_CLIENT_SECRET, '${{ secrets.KOALA_WHMCS_CLIENT_SECRET }}')
  for (const step of steps.filter((step: { name?: string }) => step.name !== 'Build')) {
    assert.equal(step.env?.KOALA_WHMCS_CLIENT_SECRET, undefined)
  }
  assert.equal(workflow.env?.KOALA_WHMCS_CLIENT_SECRET, undefined)
  assert.equal(workflow.jobs.build.env?.KOALA_WHMCS_CLIENT_SECRET, undefined)
})
