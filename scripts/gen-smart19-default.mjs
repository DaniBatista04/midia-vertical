/**
 * Gera os materiais default do smart19.
 *
 * O creativeGroup do Kuma exige entrada para os quatro device styles. Nós só
 * produzimos arte para 1080×1920 (smart32 / smart55) e 1080×2560 (smart25),
 * e o spec permite subir "material default" no style que não tem criativo
 * real. O 19" é split: precisa de dois materiais, tela de cima 1920×1080 e
 * tela de baixo 768×1366.
 *
 * É um placeholder deliberado — troque por arte de marca quando existir.
 *
 *   node scripts/gen-smart19-default.mjs
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "public/assets/kuma");
const CHROME =
  process.env.CHROME_PATH ??
  `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;

const SIZES = [
  { file: "smart19-default-top-1920x1080.jpg", w: 1920, h: 1080 },
  { file: "smart19-default-bottom-768x1366.jpg", w: 768, h: 1366 },
];

/** Fundo escuro com a marca centralizada, no mesmo tom do gerador de clima. */
function html(w, h) {
  const unit = Math.min(w, h);
  return `<!doctype html><meta charset="utf-8">
<style>
  @font-face {
    font-family: 'InterCard'; font-weight: 700; font-display: block;
    src: url('file://${process.cwd()}/public/fonts/inter-card-700.woff2') format('woff2');
  }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${w}px; height: ${h}px;
    background: linear-gradient(180deg, #060b14 0%, #0d1e35 100%);
    display: flex; align-items: center; justify-content: center;
    font-family: 'InterCard', sans-serif;
  }
  .mark {
    font-weight: 700;
    font-size: ${unit * 0.075}px;
    letter-spacing: ${unit * 0.012}px;
    color: rgba(255,255,255,0.88);
    text-transform: uppercase;
  }
  .mark span { color: #5ce3ff; }
  .rule {
    width: ${unit * 0.42}px; height: ${Math.max(1, unit * 0.003)}px;
    background: rgba(255,255,255,0.14);
    margin: ${unit * 0.045}px auto 0;
  }
  .wrap { text-align: center; }
</style>
<div class="wrap">
  <div class="mark">focus<span>media</span></div>
  <div class="rule"></div>
</div>`;
}

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

for (const { file, w, h } of SIZES) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(html(w, h), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const dest = path.join(OUT, file);
  await page.screenshot({ path: dest, type: "jpeg", quality: 92 });
  await page.close();
  console.log(`${file} — ${w}×${h} — ${(fs.statSync(dest).size / 1024).toFixed(0)} KB`);
}

await browser.close();
