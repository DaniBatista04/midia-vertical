import { drawIcon } from "./icons";
import { SPONSOR_LOGO, type WeatherScene } from "./spec";

/* ── Logo do oferecimento ────────────────────────────────────── */
let logoImg: HTMLImageElement | null = null;
let logoPromise: Promise<HTMLImageElement> | null = null;

export function loadLogo(): Promise<HTMLImageElement> {
  if (!logoPromise) {
    logoPromise = new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        logoImg = img;
        res(img);
      };
      img.onerror = () => rej(new Error("logo não carregou"));
      img.src = SPONSOR_LOGO;
    });
  }
  return logoPromise;
}

/* ── Utilitários de desenho ──────────────────────────────────── */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Par ícone + valor, centralizado no x informado. */
function drawRowStat(
  ctx: CanvasRenderingContext2D,
  x: number, midY: number, icon: string, value: string, sc: number,
) {
  ctx.textBaseline = "middle";

  const iconFs = 18 * sc;
  const valueFs = 26 * sc;
  const gap = 6 * sc;

  ctx.font = `600 ${valueFs}px 'Inter', sans-serif`;
  const valueW = ctx.measureText(value).width;
  const iconW = iconFs; // aproximação quadrada para emoji
  const totalW = iconW + gap + valueW;
  const startX = x - totalW / 2;

  ctx.font = `${iconFs}px serif`;
  ctx.fillStyle = "rgba(255,255,255,0.50)";
  ctx.textAlign = "left";
  ctx.fillText(icon, startX, midY);

  ctx.font = `600 ${valueFs}px 'Inter', sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.fillText(value, startX + iconW + gap, midY);
}

/** Fundo em degradê + brilho radial, comum aos dois modos. */
function drawBackground(
  ctx: CanvasRenderingContext2D, W: number, H: number, bg1: string, bg2: string,
) {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, bg1);
  grad.addColorStop(1, bg2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W * 0.5, H * 0.3, 0, W * 0.5, H * 0.3, W * 0.9);
  glow.addColorStop(0, "rgba(80,130,220,0.07)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

/** Cabeçalho: cidade + data por extenso. */
function drawHeader(
  ctx: CanvasRenderingContext2D,
  W: number, headerH: number, city: string, selectedDate: Date, sc: number,
) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.font = `700 ${70 * sc}px 'DM Sans', sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillText(city.toUpperCase(), W * 0.5, headerH * 0.38);

  ctx.font = `400 ${26 * sc}px 'Inter', sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.32)";
  ctx.fillText(
    selectedDate
      .toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })
      .toUpperCase(),
    W * 0.5,
    headerH * 0.75,
  );
}

/** Rodapé com "Oferecimento | logo" centralizado. */
function drawFooter(
  ctx: CanvasRenderingContext2D, W: number, H: number, footerH: number, M: number, sc: number,
) {
  const footerY = H - footerH;

  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(0, footerY, W, footerH);

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1 * sc;
  ctx.beginPath();
  ctx.moveTo(M, footerY);
  ctx.lineTo(W - M, footerY);
  ctx.stroke();

  const footMidY = footerY + footerH * 0.5;
  const logoH = footerH * 0.52;
  const logoW = logoH * 2.04; // proporção 274:134
  const textFs = 28 * sc;

  ctx.font = `300 ${textFs}px 'DM Sans', sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  const label = "Oferecimento  |";
  const textW = ctx.measureText(label).width;
  const gap = 22 * sc;
  const groupW = textW + gap + logoW;
  const groupX = (W - groupW) / 2;

  ctx.fillText(label, groupX + textW, footMidY);

  if (logoImg?.complete) {
    ctx.globalAlpha = 0.75;
    ctx.drawImage(logoImg, groupX + textW + gap, footMidY - logoH / 2, logoW, logoH);
    ctx.globalAlpha = 1;
  }

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

/* ══════════════════════════════════════════════════════════════
   Semana — uma linha por dia
   ══════════════════════════════════════════════════════════════ */
function drawWeek(canvas: HTMLCanvasElement, scene: Extract<WeatherScene, { mode: "week" }>, t: number) {
  const { days, appearance: ap } = scene;
  if (!days.length) return;

  const W = canvas.width;
  const H = canvas.height;
  const sc = W / 1080;
  const ctx = canvas.getContext("2d")!;
  const sp = 1.0; // velocidade dos ícones fixa

  drawBackground(ctx, W, H, ap.bg1, ap.bg2);

  const N = days.length;
  const headerH = H * 0.1;
  drawHeader(ctx, W, headerH, scene.city, scene.selectedDate, sc);

  const footerH = H * 0.07;
  const rowsH = H - headerH - footerH - 8 * sc;
  const rowH = rowsH / N;

  const M = 60 * sc; // margem lateral
  const USE = W - M * 2; // largura útil

  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1 * sc;
  ctx.beginPath();
  ctx.moveTo(M, headerH);
  ctx.lineTo(W - M, headerH);
  ctx.stroke();

  const COL = {
    day: M + USE * 0.0,
    icon: M + USE * 0.22,
    temp: M + USE * 0.45,
    hum: M + USE * 0.615,
    rain: M + USE * 0.775,
    wind: M + USE * 0.93,
  };

  // Rótulos das colunas
  const colLabelY = headerH + rowH * 0.18;
  ctx.font = `600 ${20 * sc}px 'Inter', sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ([
    [COL.temp, "MÁX / MÍN"],
    [COL.hum, "UMIDADE"],
    [COL.rain, "CHUVA"],
    [COL.wind, "VENTO"],
  ] as const).forEach(([x, lbl]) => ctx.fillText(lbl, x, colLabelY));

  for (let i = 0; i < N; i++) {
    const d = days[i];
    const ck = d.condKey;
    const rowY = headerH + i * rowH;
    const midY = rowY + rowH * 0.5;

    if (d.isToday) {
      ctx.fillStyle = `${ap.todayCol}40`;
      roundRect(ctx, M * 0.4, rowY + 4 * sc, W - M * 0.8, rowH - 8 * sc, 12 * sc);
      ctx.fill();
      ctx.fillStyle = ap.todayCol;
      roundRect(ctx, M * 0.4, rowY + rowH * 0.2, 4 * sc, rowH * 0.6, 2 * sc);
      ctx.fill();
    }

    if (i > 0) {
      ctx.strokeStyle = `${ap.divCol}55`;
      ctx.lineWidth = 1 * sc;
      ctx.beginPath();
      ctx.moveTo(M * 0.4, rowY);
      ctx.lineTo(W - M * 0.4, rowY);
      ctx.stroke();
    }

    ctx.textBaseline = "middle";

    // Dia + data
    ctx.textAlign = "left";
    ctx.font = `700 ${34 * sc}px 'Inter', sans-serif`;
    ctx.fillStyle = d.isToday ? "#e8ff47" : "rgba(255,255,255,0.90)";
    ctx.fillText(d.weekday.toUpperCase(), COL.day, midY - 12 * sc);

    ctx.font = `400 ${22 * sc}px 'Inter', sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.32)";
    ctx.fillText(d.date, COL.day, midY + 16 * sc);

    // Ícone
    drawIcon(ctx, ck, COL.icon, midY, rowH * 0.52, t, sp, ap.rainSpeed);

    // Máx / mín
    ctx.font = `700 ${46 * sc}px 'Inter', sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "right";
    ctx.fillText(`${d.max}°`, COL.temp - 10 * sc, midY - 2 * sc);

    ctx.font = `300 ${30 * sc}px 'Inter', sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.textAlign = "center";
    ctx.fillText("/", COL.temp + 14 * sc, midY + 2 * sc);

    ctx.font = `300 ${34 * sc}px 'Inter', sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.40)";
    ctx.textAlign = "left";
    ctx.fillText(`${d.min}°`, COL.temp + 28 * sc, midY + 2 * sc);

    drawRowStat(ctx, COL.hum, midY, "💧", d.humidity !== "—" ? `${d.humidity}%` : "—", sc);
    drawRowStat(ctx, COL.rain, midY, "🌧", d.rain_prob !== "—" ? `${d.rain_prob}%` : "—", sc);
    drawRowStat(ctx, COL.wind, midY, "💨", `${d.wind}`, sc);
  }

  drawFooter(ctx, W, H, footerH, M, sc);
}

/* ══════════════════════════════════════════════════════════════
   Dia — uma linha por horário
   ══════════════════════════════════════════════════════════════ */
function drawDay(canvas: HTMLCanvasElement, scene: Extract<WeatherScene, { mode: "day" }>, t: number) {
  const { slots, appearance: ap } = scene;
  if (!slots.length) return;

  const W = canvas.width;
  const H = canvas.height;
  const sc = W / 1080;
  const ctx = canvas.getContext("2d")!;
  const sp = 1.0;

  drawBackground(ctx, W, H, ap.bg1, ap.bg2);

  const N = slots.length;
  const headerH = H * 0.1;
  drawHeader(ctx, W, headerH, scene.city, scene.selectedDate, sc);

  const footerH = H * 0.07;
  const rowsH = H - headerH - footerH - 8 * sc;
  const rowH = rowsH / N;

  const M = 60 * sc;
  const USE = W - M * 2;

  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1 * sc;
  ctx.beginPath();
  ctx.moveTo(M, headerH);
  ctx.lineTo(W - M, headerH);
  ctx.stroke();

  const COL = {
    hour: M + USE * 0.0,
    icon: M + USE * 0.22,
    temp: M + USE * 0.46,
    rain: M + USE * 0.68,
    wind: M + USE * 0.9,
  };

  const colLabelY = headerH + rowH * 0.18;
  ctx.font = `600 ${20 * sc}px 'Inter', sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ([
    [COL.temp, "TEMPERATURA"],
    [COL.rain, "CHUVA"],
    [COL.wind, "VENTO"],
  ] as const).forEach(([x, l]) => ctx.fillText(l, x, colLabelY));

  for (let i = 0; i < N; i++) {
    const s = slots[i];
    const rowY = headerH + i * rowH;
    const midY = rowY + rowH * 0.5;

    if (i > 0) {
      ctx.strokeStyle = `${ap.divCol}55`;
      ctx.lineWidth = 1 * sc;
      ctx.beginPath();
      ctx.moveTo(M * 0.4, rowY);
      ctx.lineTo(W - M * 0.4, rowY);
      ctx.stroke();
    }

    ctx.textBaseline = "middle";

    ctx.textAlign = "left";
    ctx.font = `700 ${38 * sc}px 'Inter', sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.90)";
    ctx.fillText(s.hour, COL.hour, midY);

    drawIcon(ctx, s.condKey, COL.icon, midY, rowH * 0.52, t, sp, ap.rainSpeed);

    ctx.textAlign = "center";
    ctx.font = `700 ${52 * sc}px 'Inter', sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`${s.temp}°`, COL.temp, midY);

    drawRowStat(ctx, COL.rain, midY, "🌧", s.rain_prob !== "—" ? `${s.rain_prob}%` : "—", sc);
    drawRowStat(ctx, COL.wind, midY, "💨", `${s.wind}`, sc);
  }

  drawFooter(ctx, W, H, footerH, M, sc);
}

/** Desenha um frame da cena no instante `t` (ms). */
export function drawFrame(canvas: HTMLCanvasElement, scene: WeatherScene, t: number) {
  if (scene.mode === "day") drawDay(canvas, scene, t);
  else drawWeek(canvas, scene, t);
}
