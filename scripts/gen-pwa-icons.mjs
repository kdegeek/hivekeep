// Regenerates the PWA raster icons (favicon, app icons, apple-touch, maskable)
// from the master mark in logo.svg, using a headless Chromium to rasterize.
//
// The logo.svg master is produced by gen-logo-assets.mjs (baked-gradient bee in
// honeycomb). Those PNG/ICO outputs are NOT covered by gen-logo-assets.mjs, so
// after any logo change run BOTH:
//   bun scripts/gen-logo-assets.mjs && bun scripts/gen-pwa-icons.mjs
//
// Outputs (all under src/client/public/):
//   hivekeep.svg                 vector master copy (transparent)
//   favicon.ico                  16/32/48 frames (transparent)
//   hivekeep-192.png             "any" app icon, dark bg
//   hivekeep-512.png             "any" app icon, dark bg
//   hivekeep-maskable-512.png    "maskable" icon, extra safe-zone padding
//   apple-touch-icon.png         iOS home screen (opaque dark bg)
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { chromium } from 'playwright'

const root = new URL('..', import.meta.url)
const pub = new URL('./src/client/public/', root)

// Dark brand surface, matches manifest background_color.
const BG = '#1a1a2e'

const masterSvg = readFileSync(new URL('./logo.svg', root), 'utf8')
  // Drop the baked width/height so CSS can size it to fill its container.
  .replace(/\s(width|height)="\d+"/g, '')

function pageHtml(size, mark, bg) {
  // mark = fraction of the canvas the logomark occupies (the rest is padding).
  const markPx = Math.round(size * mark)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0}
    .canvas{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:${bg}}
    .mark{width:${markPx}px;height:${markPx}px}
    .mark svg{width:100%;height:100%;display:block}
  </style></head><body>
    <div class="canvas"><div class="mark">${masterSvg}</div></div>
  </body></html>`
}

async function render(page, size, mark, { transparent } = {}) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(pageHtml(size, mark, transparent ? 'transparent' : BG), {
    waitUntil: 'load',
  })
  return page.screenshot({
    clip: { x: 0, y: 0, width: size, height: size },
    omitBackground: !!transparent,
    type: 'png',
  })
}

// Minimal ICO container holding PNG-encoded frames (every modern browser reads
// PNG-in-ICO). Header + one 16-byte directory entry per frame, then the data.
function buildIco(frames) {
  const count = frames.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)

  const dir = Buffer.alloc(count * 16)
  let offset = 6 + count * 16
  frames.forEach((f, i) => {
    const e = i * 16
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, e + 0) // width (0 => 256)
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, e + 1) // height
    dir.writeUInt8(0, e + 2) // palette
    dir.writeUInt8(0, e + 3) // reserved
    dir.writeUInt16LE(1, e + 4) // color planes
    dir.writeUInt16LE(32, e + 6) // bits per pixel
    dir.writeUInt32LE(f.data.length, e + 8) // bytes in resource
    dir.writeUInt32LE(offset, e + 12) // offset
    offset += f.data.length
  })

  return Buffer.concat([header, dir, ...frames.map((f) => f.data)])
}

const browser = await chromium.launch()
const page = await browser.newPage({ deviceScaleFactor: 1 })

// App icons on the dark brand surface. "any" icons fill more; the maskable
// variant keeps the mark inside the ~80% safe circle the platform may crop to.
const APP_ICONS = [
  { file: 'hivekeep-192.png', size: 192, mark: 0.78 },
  { file: 'hivekeep-512.png', size: 512, mark: 0.78 },
  { file: 'hivekeep-maskable-512.png', size: 512, mark: 0.6 },
  { file: 'apple-touch-icon.png', size: 180, mark: 0.74 },
]
for (const { file, size, mark } of APP_ICONS) {
  const png = await render(page, size, mark)
  writeFileSync(new URL(file, pub), png)
}

// Favicon: transparent frames so the mark sits on any tab background.
const FAVICON_SIZES = [16, 32, 48]
const frames = []
for (const size of FAVICON_SIZES) {
  const data = await render(page, size, 0.92, { transparent: true })
  frames.push({ size, data })
}
writeFileSync(new URL('favicon.ico', pub), buildIco(frames))

await browser.close()

// Vector master used by <link rel="icon" type="image/svg+xml"> and other
// plain <img> contexts.
copyFileSync(new URL('./logo.svg', root), new URL('hivekeep.svg', pub))

console.log(
  `regenerated ${APP_ICONS.length} app icons + favicon.ico (${FAVICON_SIZES.join('/')}) + hivekeep.svg`,
)
