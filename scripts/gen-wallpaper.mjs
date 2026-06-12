// Generates a Hivekeep brand wallpaper (dark aurora + honeycomb grid + bee mark).
// Run: bun scripts/gen-wallpaper.mjs [width] [height]
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const W = Number(process.argv[2] || 2560)
const H = Number(process.argv[3] || 1440)

const { paths } = JSON.parse(
  readFileSync(new URL('./logo-paths.json', import.meta.url), 'utf8'),
)
const MARK_VIEWBOX = '152 128 950 950'
const GL = { x1: 201, y1: 226, x2: 1052, y2: 980 }
const markBody = paths.map((d) => `<path d="${d}"/>`).join('')

// --- Honeycomb grid (flat-top hexagons), brighter near the center ----------
const cx = W / 2
const cy = H / 2
const s = Math.round(Math.min(W, H) / 22) // hex size (center -> vertex)
const colStep = 1.5 * s
const rowStep = Math.sqrt(3) * s
const verts = (x, y) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i)
    return `${(x + s * Math.cos(a)).toFixed(1)},${(y + s * Math.sin(a)).toFixed(1)}`
  }).join(' ')

let hexes = ''
for (let col = -1; col * colStep < W + s; col++) {
  const x = col * colStep
  const yOff = col & 1 ? rowStep / 2 : 0
  for (let row = -1; row * rowStep + yOff < H + s; row++) {
    const y = row * rowStep + yOff
    const dist = Math.hypot(x - cx, y - cy)
    const glow = Math.max(0, 1 - dist / (Math.min(W, H) * 0.52))
    const op = Math.min(0.22, 0.045 + 0.16 * glow * glow)
    const sw = (1.4 + 1.1 * glow).toFixed(2)
    hexes += `<polygon points="${verts(x, y)}" fill="none" stroke="#ffffff" stroke-opacity="${op.toFixed(3)}" stroke-width="${sw}"/>`
  }
}

const markSize = Math.round(Math.min(W, H) * 0.34)

const html = `<!doctype html><html><head><meta charset="utf8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${W}px;height:${H}px;overflow:hidden}
  .stage{position:relative;width:${W}px;height:${H}px;
    background:radial-gradient(ellipse 90% 80% at 50% 42%, #150b29 0%, #0c0717 55%, #070410 100%);}
  .orb{position:absolute;border-radius:50%;filter:blur(40px)}
  .grid{position:absolute;inset:0}
  .glow{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border-radius:50%;
    width:${Math.round(Math.min(W, H) * 0.95)}px;height:${Math.round(Math.min(W, H) * 0.95)}px;
    background:radial-gradient(circle, rgba(174,90,249,.40) 0%, rgba(251,95,202,.18) 38%, transparent 66%);
    filter:blur(30px)}
  .mark{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
    filter:drop-shadow(0 18px 60px rgba(174,90,249,.45)) drop-shadow(0 4px 18px rgba(251,95,202,.35))}
</style></head><body>
  <div class="stage">
    <div class="orb" style="width:${Math.round(W * 0.5)}px;height:${Math.round(W * 0.5)}px;left:-12%;top:-22%;
      background:radial-gradient(circle, rgba(174,90,249,.55) 0%, transparent 64%);opacity:.55"></div>
    <div class="orb" style="width:${Math.round(W * 0.52)}px;height:${Math.round(W * 0.52)}px;right:-14%;bottom:-26%;
      background:radial-gradient(circle, rgba(251,95,202,.50) 0%, transparent 64%);opacity:.5"></div>
    <div class="orb" style="width:${Math.round(W * 0.4)}px;height:${Math.round(W * 0.4)}px;right:2%;top:8%;
      background:radial-gradient(circle, rgba(255,180,112,.34) 0%, transparent 66%);opacity:.5"></div>

    <div class="glow"></div>

    <svg class="grid" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${hexes}</svg>

    <svg class="mark" width="${markSize}" height="${markSize}" viewBox="${MARK_VIEWBOX}" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="m" gradientUnits="userSpaceOnUse" x1="${GL.x1}" y1="${GL.y1}" x2="${GL.x2}" y2="${GL.y2}">
        <stop stop-color="#AE5AF9"/><stop offset=".52" stop-color="#FB5FCA"/><stop offset="1" stop-color="#FFB470"/>
      </linearGradient></defs>
      <g fill="url(#m)">${markBody}</g>
    </svg>
  </div>
</body></html>`

const out = new URL(`../hivekeep-video/wallpaper-hivekeep-${W}x${H}.png`, import.meta.url)
const browser = await chromium.launch({
  executablePath:
    '/home/marlburrow/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.screenshot({ path: out.pathname, clip: { x: 0, y: 0, width: W, height: H } })
await browser.close()
console.log('wrote', out.pathname)
