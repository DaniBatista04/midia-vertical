import { SPEC, type NewsControls, type NewsFormat, type NewsItem } from "./spec";
import { fillTracked, setFont, wrapTracked } from "./text";

/* ── Fontes ──────────────────────────────────────────────────── */
let fontsReady: Promise<unknown> | null = null;

export function ensureFonts() {
  if (!fontsReady) {
    fontsReady = Promise.all([
      document.fonts.load("500 115px InterCard"),
      document.fonts.load("700 46px InterCard"),
    ]).then(() => document.fonts.ready);
  }
  return fontsReady;
}

/* ── Assets estáticos (máscara e barra) ──────────────────────── */
const assets: Record<string, Promise<HTMLImageElement>> = {};

export function loadAsset(src: string): Promise<HTMLImageElement> {
  if (!assets[src]) {
    assets[src] = new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("asset"));
      img.src = src;
    });
  }
  return assets[src];
}

/* ── Imagem do feed, sempre via /api/image (CORS) ────────────── */
const imgCache: Record<string, Promise<HTMLImageElement>> = {};

export function proxiedImage(url: string) {
  return `/api/image?url=${encodeURIComponent(url)}`;
}

export function loadImg(url: string): Promise<HTMLImageElement> {
  const pu = proxiedImage(url);
  if (!imgCache[pu]) {
    imgCache[pu] = new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => res(img);
      img.onerror = () => {
        delete imgCache[pu];
        rej(new Error("imagem não carregou"));
      };
      img.src = pu;
    });
  }
  return imgCache[pu];
}

/* ══════════════════════════════════════════════════════════════
   HALO DA FOTO

   A máscara é opaca fora do furo, então um brilho desenhado antes
   dela seria coberto. A saída aqui é derivar a silhueta do furo a
   partir da própria máscara, aplicar o desfoque e apagar o interior
   — sobra só o anel de brilho, que entra por cima da máscara com o
   contorno exato do design.

   O resultado só depende da máscara, do desfoque e da força, então
   fica em cache por formato e escala.
   ══════════════════════════════════════════════════════════════ */
const glowCache: Record<string, HTMLCanvasElement> = {};

async function glowLayer(
  fmt: NewsFormat,
  W: number,
  H: number,
  blur: number,
  alpha: number,
): Promise<HTMLCanvasElement> {
  const key = `${fmt.w}x${fmt.h}|${W}x${H}|${blur.toFixed(2)}|${alpha.toFixed(3)}`;
  if (glowCache[key]) return glowCache[key];

  const mask = await loadAsset(fmt.mask);
  const mk = () => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    return c;
  };

  // Silhueta branca do furo: pinta tudo e remove onde a máscara é opaca.
  const sil = mk();
  const sc2 = sil.getContext("2d")!;
  sc2.fillStyle = "#fff";
  sc2.fillRect(0, 0, W, H);
  sc2.globalCompositeOperation = "destination-out";
  sc2.drawImage(mask, 0, 0, W, H);

  // Silhueta + desfoque, depois apaga o interior.
  const g = mk();
  const gc = g.getContext("2d")!;
  gc.shadowColor = `rgba(255,255,255,${alpha})`;
  gc.shadowBlur = blur;
  gc.drawImage(sil, 0, 0);
  gc.shadowColor = "transparent";
  gc.shadowBlur = 0;
  gc.globalCompositeOperation = "destination-out";
  gc.drawImage(sil, 0, 0);

  glowCache[key] = g;
  return g;
}

/* ══════════════════════════════════════════════════════════════
   AJUSTE DO TÍTULO

   Reduz o corpo até a manchete caber no espaço entre a editoria e a
   barra. O número de linhas permitido sai da geometria: com o corpo
   nominal dá 6 linhas no 1920 e 8 no 2560, igual à especificação.
   ══════════════════════════════════════════════════════════════ */
export type TitleFit = {
  size: number;
  lead: number;
  lines: string[];
  maxLines: number;
  shrunk: boolean;
  overflow: boolean;
};

function fitTitle(
  ctx: CanvasRenderingContext2D,
  text: string,
  fmt: NewsFormat,
  nomSize: number,
  nomLead: number,
  maxW: number,
  limitY: number,
  sc: number,
  auto: boolean,
): TitleFit {
  const floor = Math.max(20, nomSize * 0.5);
  let size = nomSize;
  let last: TitleFit | null = null;

  for (let guard = 0; guard < 200; guard++) {
    const lead = nomLead * (size / nomSize);
    const maxLines = Math.max(1, Math.floor((limitY - fmt.ttlBaseline) / lead) + 1);
    setFont(ctx, SPEC.ttl.weight, size * sc, SPEC.ttl.track);
    const lines = wrapTracked(ctx, text, maxW * sc, (SPEC.ttl.track / 1000) * size * sc);
    const fits = lines.length <= maxLines;
    last = { size, lead, lines, maxLines, shrunk: size < nomSize, overflow: !fits };
    if (fits || !auto || size <= floor) return last;
    size -= 1;
  }
  return last!;
}

/* ══════════════════════════════════════════════════════════════
   DESENHO DO CARD
   ══════════════════════════════════════════════════════════════ */
export async function drawCard(
  cv: HTMLCanvasElement,
  item: NewsItem,
  sc: number,
  fmt: NewsFormat,
  c: NewsControls,
  fmtIndex: number,
): Promise<TitleFit> {
  await ensureFonts();
  const ctx = cv.getContext("2d")!;
  const W = cv.width;
  const H = cv.height;
  const marginX = c.marginX;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = SPEC.colors.bg;
  ctx.fillRect(0, 0, W, H);

  // ── 1. Foto, recortada em "cover" dentro do furo da máscara ──
  const hole = fmt.hole;
  if (item.imgUrl) {
    try {
      const img = await loadImg(item.imgUrl);
      // 1px de sangria: a máscara cobre a sobra.
      const dx = (hole.x - 1) * sc;
      const dy = (hole.y - 1) * sc;
      const dw = (hole.w + 2) * sc;
      const dh = (hole.h + 2) * sc;
      const ir = img.width / img.height;
      const cr = dw / dh;
      const panX = c.imgX / 100;
      let sx: number, sy: number, sw: number, sh: number;
      if (ir > cr) {
        // Fonte mais larga: corta lateral.
        sh = img.height;
        sw = sh * cr;
        const slack = img.width - sw;
        sx = Math.max(0, Math.min(slack, slack / 2 + (panX * slack) / 2));
        sy = 0;
      } else {
        // Fonte mais alta: corta topo/base.
        sw = img.width;
        sh = sw / cr;
        sx = 0;
        sy = (img.height - sh) / 2;
      }
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    } catch {
      ctx.fillStyle = "#161616";
      ctx.fillRect(hole.x * sc, hole.y * sc, hole.w * sc, hole.h * sc);
    }
  }

  // ── 2. Máscara: recorta os cantos e devolve o preto do card ──
  try {
    const mask = await loadAsset(fmt.mask);
    ctx.drawImage(mask, 0, 0, W, H);

    // 2b. Halo branco por cima da máscara, separando a foto do fundo.
    if (c.glowOn && c.glowBlur > 0) {
      ctx.drawImage(await glowLayer(fmt, W, H, c.glowBlur * sc, c.glowOp / 100), 0, 0);
    }
  } catch {
    console.warn("máscara não carregou");
  }

  // ── 3. Crédito da foto, rotacionado -90° na borda direita ──
  if (c.credOn && item.imageCredits) {
    const cs = c.credSize * sc;
    ctx.save();
    ctx.translate(
      (hole.x + hole.w - SPEC.cred.insetX) * sc,
      (hole.y + hole.h - SPEC.cred.insetY) * sc,
    );
    ctx.rotate(-Math.PI / 2);
    setFont(ctx, SPEC.cred.weight, cs, SPEC.cred.track);
    ctx.fillStyle = c.credColor;
    ctx.textBaseline = "alphabetic";
    ctx.shadowColor = "rgba(0,0,0,.55)";
    ctx.shadowBlur = 5 * sc;
    fillTracked(ctx, item.imageCredits, 0, 0, (SPEC.cred.track / 1000) * cs);
    ctx.restore();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
  }

  // ── 4. Editoria ─────────────────────────────────────────────
  ctx.textBaseline = "alphabetic";
  if (item.editoria) {
    const es = SPEC.ed.size * sc;
    setFont(ctx, SPEC.ed.weight, es, SPEC.ed.track);
    ctx.fillStyle = c.edColor;
    fillTracked(
      ctx,
      item.editoria.toUpperCase(),
      marginX * sc,
      fmt.edBaseline * sc,
      (SPEC.ed.track / 1000) * es,
    );
  }

  // ── 5. Barra do rodapé: mede agora, desenha por último ──────
  let bar: HTMLImageElement | null = null;
  let barH = 0;
  let barTop = H / sc;
  try {
    bar = await loadAsset(fmt.barra);
    barH = bar.height * (W / bar.width);
    barTop = (H - barH) / sc;
  } catch {
    console.warn("barra não carregou");
  }

  // ── 6. Título, com ajuste automático de corpo ───────────────
  const nomSize = fmtIndex === 0 ? c.tSize1 : c.tSize2;
  const nomLead = fmtIndex === 0 ? c.tLead1 : c.tLead2;
  const fit = fitTitle(
    ctx,
    item.title,
    fmt,
    nomSize,
    nomLead,
    c.boxW,
    barTop - SPEC.bottomGap,
    sc,
    c.autoFit,
  );

  ctx.fillStyle = c.titleColor;
  setFont(ctx, SPEC.ttl.weight, fit.size * sc, SPEC.ttl.track);
  const trackPx = (SPEC.ttl.track / 1000) * fit.size * sc;
  fit.lines.forEach((ln, i) => {
    fillTracked(ctx, ln, marginX * sc, (fmt.ttlBaseline + i * fit.lead) * sc, trackPx);
  });

  // ── 7. Barra + "continue no appnews" por cima do título ─────
  if (bar) {
    ctx.drawImage(bar, 0, H - barH, W, barH);
    const cs = SPEC.cap.size * sc;
    setFont(ctx, SPEC.cap.weight, cs, SPEC.cap.track);
    ctx.fillStyle = c.edColor;
    fillTracked(
      ctx,
      SPEC.cap.text,
      SPEC.cap.x * sc,
      (barTop + fmt.qrBottom + SPEC.cap.gap) * sc,
      (SPEC.cap.track / 1000) * cs,
    );
  }

  return fit;
}

/** Renderiza o card em resolução final e devolve o JPG. */
export async function renderJpeg(
  item: NewsItem,
  fmt: NewsFormat,
  fmtIndex: number,
  c: NewsControls,
): Promise<Blob> {
  const tmp = document.createElement("canvas");
  tmp.width = fmt.w;
  tmp.height = fmt.h;
  await drawCard(tmp, item, 1, fmt, c, fmtIndex);
  const blob = await new Promise<Blob | null>((r) =>
    tmp.toBlob(r, "image/jpeg", c.jpgQ / 100),
  );
  if (!blob) throw new Error("falha ao gerar o JPG");
  return blob;
}
