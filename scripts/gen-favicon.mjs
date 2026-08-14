/**
 * Gera favicon.ico e apple-icon.png a partir de src/app/icon.svg.
 *
 * O Next serve o icon.svg sozinho, mas navegador antigo e atalho de desktop
 * ainda pedem /favicon.ico — e o .ico precisa carregar vários tamanhos, senão
 * o sistema reescala mal e o ícone borra na barra de tarefas.
 *
 *   node scripts/gen-favicon.mjs
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const APP = path.join(process.cwd(), "src/app");
const SVG = fs.readFileSync(path.join(APP, "icon.svg"), "utf8");
const CHROME =
  process.env.CHROME_PATH ??
  `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;

/** Tamanhos que entram no .ico. */
const ICO_SIZES = [16, 32, 48, 64];
/** iOS usa 180×180 para o ícone da tela de início. */
const APPLE_SIZE = 180;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function render(size) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<!doctype html><meta charset="utf-8">
     <style>html,body{margin:0;padding:0;background:transparent}
     svg{display:block;width:${size}px;height:${size}px}</style>${SVG}`,
    { waitUntil: "load" },
  );
  const buf = await page.screenshot({ omitBackground: true, type: "png" });
  await page.close();
  return buf;
}

/**
 * Empacota PNGs num .ico.
 *
 * O formato aceita PNG embutido desde o Vista, o que evita converter para
 * bitmap e preservar canal alfa na unha.
 */
function packIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reservado
  header.writeUInt16LE(1, 2); // tipo 1 = ícone
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;

  for (const { size, buf } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // largura (0 significa 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // altura
    e.writeUInt8(0, 2); // paleta
    e.writeUInt8(0, 3); // reservado
    e.writeUInt16LE(1, 4); // planos
    e.writeUInt16LE(32, 6); // bits por pixel
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += buf.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.buf)]);
}

const icoImages = [];
for (const size of ICO_SIZES) {
  icoImages.push({ size, buf: await render(size) });
}
const ico = packIco(icoImages);
fs.writeFileSync(path.join(APP, "favicon.ico"), ico);
console.log(`favicon.ico — ${ICO_SIZES.join("/")}px — ${(ico.length / 1024).toFixed(1)} KB`);

const apple = await render(APPLE_SIZE);
fs.writeFileSync(path.join(APP, "apple-icon.png"), apple);
console.log(`apple-icon.png — ${APPLE_SIZE}×${APPLE_SIZE} — ${(apple.length / 1024).toFixed(1)} KB`);

await browser.close();
