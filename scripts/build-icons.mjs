/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript build script. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

// The UI and every packaged icon share this vector source.
const root = fileURLToPath(new URL('../', import.meta.url))
const target = (name) => join(root, name)
const mark = readFileSync(target('src/renderer/src/assets/brand-mark.svg'), 'utf8')
const markContent = mark.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
// Desktop icons need a tile and internal padding; the sidebar uses the bare mark.
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" fill="none">
  <defs>
    <linearGradient id="tile" x1="50" y1="8" x2="50" y2="92" gradientUnits="userSpaceOnUse">
      <stop stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#F2F4F2"/>
    </linearGradient>
    <filter id="shadow" x="0" y="0" width="100" height="100" filterUnits="userSpaceOnUse">
      <feDropShadow dx="0" dy="1.45" stdDeviation="1.25" flood-color="#234537" flood-opacity="0.2"/>
    </filter>
  </defs>
  <rect x="8" y="8" width="84" height="84" rx="19" fill="url(#tile)" filter="url(#shadow)"/>
  <rect x="8.4" y="8.4" width="83.2" height="83.2" rx="18.6" stroke="#FFFFFF" stroke-width="0.8"/>
  <g transform="translate(15 14.65) scale(0.7)">${markContent}</g>
</svg>`
const solidTemplate = mark.replace(/fill="#[0-9a-f]{6}"/gi, 'fill="#000000"')
// Outline the merged alpha silhouette, including the keyhole. Stroking individual
// ear/head shapes would expose their overlapping edges in the menu bar.
const solidContent = solidTemplate.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
const outlineTemplate = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <defs>
    <filter id="outline" x="0" y="0" width="100" height="100" filterUnits="userSpaceOnUse">
      <feMorphology in="SourceAlpha" operator="erode" radius="4.5" result="inner"/>
      <feComposite in="SourceGraphic" in2="inner" operator="out"/>
    </filter>
  </defs>
  <g filter="url(#outline)">${solidContent}</g>
</svg>`

async function render(svg, size) {
  // Rasterize the 100-unit vector at the destination resolution, including Retina.
  return sharp(Buffer.from(svg), { density: (72 * size) / 100 })
    .resize(size, size)
    .png()
    .toBuffer()
}

// ICO supports PNG payloads; include small sizes for Windows tray and shortcuts.
function writeIco(images, output) {
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const header = Buffer.alloc(6 + sizes.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  const payloads = sizes.map((size, index) => {
    const image = images.get(size)
    const entry = 6 + index * 16
    header[entry] = header[entry + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(image.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += image.length
    return image
  })
  writeFileSync(output, Buffer.concat([header, ...payloads]))
}

// Modern ICNS stores PNG representations, so icon generation works on every OS.
function writeIcns(images, output) {
  const representations = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512]
  ]
  const chunks = representations.map(([type, size]) => {
    const image = images.get(size)
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, 'ascii')
    header.writeUInt32BE(image.length + 8, 4)
    return Buffer.concat([header, image])
  })
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
  writeFileSync(output, Buffer.concat([header, ...chunks]))
}

for (const directory of ['resources/brand', 'build']) {
  mkdirSync(target(directory), { recursive: true })
}
const images = new Map(
  await Promise.all(
    [16, 24, 32, 48, 64, 128, 256, 512, 1024].map(async (size) => [
      size,
      await render(appIcon, size)
    ])
  )
)
writeFileSync(target('resources/brand/mark.png'), await render(mark, 1024))
writeFileSync(target('resources/brand/app-icon.svg'), appIcon)
for (const file of ['resources/brand/app-icon.png', 'build/icon.png']) {
  writeFileSync(target(file), images.get(1024))
}
for (const file of ['resources/icon.png', 'resources/icon_off.png']) {
  writeFileSync(target(file), images.get(512))
}
for (const [state, name, svg] of [
  ['on', 'tray-active.png', solidTemplate],
  ['off', 'tray-inactive.png', outlineTemplate]
]) {
  writeFileSync(target(`resources/brand/${name}`), await render(svg, 256))
  writeFileSync(target(`resources/icon_${state}_mac.png`), await render(svg, 20))
  writeFileSync(target(`resources/icon_${state}_mac@2x.png`), await render(svg, 40))
}
for (const file of [
  'resources/icon.ico',
  'resources/icon_off.ico',
  'build/icon.ico',
  'build/installerIcon.ico'
]) {
  writeIco(images, target(file))
}
writeIcns(images, target('build/icon.icns'))
console.log('Updated application, installer and tray icons from brand-mark.svg (including Retina).')
