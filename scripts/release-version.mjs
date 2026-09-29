/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function resolveReleaseVersion(input, current, sha) {
  const requested = input.trim()
  if (requested) {
    if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(requested)) {
      throw new Error(`Invalid release version: ${requested}`)
    }
    const version = requested.replace(/^v/, '')
    return { version, tag: `v${version}`, prerelease: false }
  }
  const base = /^(\d+)\.(\d+)\.(\d+)/.exec(current)
  if (!base || !/^[a-f0-9]{7,40}$/.test(sha)) throw new Error('Invalid base version or commit SHA')
  const version = `${base[1]}.${base[2]}.${Number(base[3]) + 1}-beta-${sha.slice(0, 7)}`
  return { version, tag: 'pre-release', prerelease: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
  const release = resolveReleaseVersion(
    process.env.INPUT_VERSION || '',
    version,
    process.env.GITHUB_SHA || ''
  )
  for (const [key, value] of Object.entries(release)) console.log(`${key}=${value}`)
}
