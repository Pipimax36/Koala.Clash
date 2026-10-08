import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'output/whmcs-services')
const apiSource = await readFile(
  resolve(root, 'integrations/whmcs/modules/addons/koala_services/lib/ServiceApi.php'),
  'utf8'
)
const version = /const ADDON_VERSION = '(\d+\.\d+\.\d+)';/.exec(apiSource)?.[1]
if (!version) throw new Error('Missing WHMCS addon version')
const name = `koala-services-${version}.zip`
const archive = new AdmZip()
// Explicit allowlist prevents credentials, fixtures and build output entering the addon.
for (const file of [
  'koala_services.php',
  'api.php',
  'lib/ServiceApi.php',
  'lib/WhmcsAdapter.php',
  'lib/OidcProof.php'
]) {
  const relative = `modules/addons/koala_services/${file}`
  archive.addFile(relative, await readFile(resolve(root, 'integrations/whmcs', relative)))
}
archive.addFile('INSTALL.md', await readFile(resolve(root, 'docs/whmcs-services-addon.md')))
const buffer = archive.toBuffer()
await mkdir(output, { recursive: true })
await writeFile(resolve(output, name), buffer)
await writeFile(
  resolve(output, `${name}.sha256`),
  `${createHash('sha256').update(buffer).digest('hex')}  ${name}\n`
)
console.log(`WHMCS addon: ${resolve(output, name)}`)
