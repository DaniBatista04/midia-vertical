/**
 * Ícones de condição desenhados no canvas.
 *
 * Cada ícone é animado em função de `t` (ms desde o início da cena), o que
 * mantém a exportação determinística: o frame N sempre desenha o mesmo
 * instante, independente de fps ou de quanto o browser demorou.
 */

export function drawCloud(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
  ctx.arc(cx + r * 0.42, cy + r * 0.18, r * 0.36, 0, Math.PI * 2);
  ctx.arc(cx - r * 0.36, cy + r * 0.12, r * 0.3, 0, Math.PI * 2);
  ctx.arc(cx + r * 0.08, cy + r * 0.34, r * 0.27, 0, Math.PI * 2);
  ctx.fill();
}

export function drawIcon(
  ctx: CanvasRenderingContext2D,
  ck: string,
  cx: number,
  cy: number,
  size: number,
  t: number,
  speed: number,
  rainSpeed: number,
) {
  const angle = t * 0.001 * speed;
  ctx.save();
  ctx.translate(cx, cy);

  switch (ck) {
    case "clear": {
      const pulse = 1 + Math.sin(angle * 2) * 0.05;
      ctx.save();
      ctx.scale(pulse, pulse);
      const sg = ctx.createRadialGradient(0, 0, size * 0.05, 0, 0, size * 0.45);
      sg.addColorStop(0, "#ffe566");
      sg.addColorStop(0.6, "#ffb300");
      sg.addColorStop(1, "rgba(255,180,0,0)");
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffcc44";
      ctx.lineWidth = size * 0.06;
      for (let i = 0; i < 8; i++) {
        ctx.save();
        ctx.rotate(angle + (i * Math.PI) / 4);
        ctx.beginPath();
        ctx.moveTo(size * 0.34, 0);
        ctx.lineTo(size * 0.48, 0);
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
      break;
    }
    case "clear_night": {
      ctx.fillStyle = "#c8dcff";
      ctx.shadowColor = "#88aaff";
      ctx.shadowBlur = size * 0.4;
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#060b14";
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(size * 0.13, -size * 0.08, size * 0.24, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "rain":
    case "drizzle": {
      drawCloud(ctx, 0, -size * 0.1, size * 0.38, "#6080a0");
      ctx.strokeStyle = "#6ab0ff";
      ctx.lineWidth = size * 0.05;
      ctx.globalAlpha = 0.8;
      const n = ck === "drizzle" ? 3 : 5;
      for (let i = 0; i < n; i++) {
        const dx = (i / (n - 1) - 0.5) * size * 0.5;
        const dy = size * 0.2 + ((t * 0.004 * rainSpeed + i * 0.25) % 1) * size * 0.25;
        ctx.beginPath();
        ctx.moveTo(dx - size * 0.03, dy);
        ctx.lineTo(dx, dy + size * 0.15);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case "storm": {
      drawCloud(ctx, 0, -size * 0.1, size * 0.4, "#405060");
      ctx.fillStyle = "#ffe566";
      ctx.shadowColor = "#ffee00";
      ctx.shadowBlur = size * 0.25;
      ctx.beginPath();
      ctx.moveTo(size * 0.05, size * 0.08);
      ctx.lineTo(-size * 0.05, size * 0.26);
      ctx.lineTo(size * 0.02, size * 0.26);
      ctx.lineTo(-size * 0.05, size * 0.44);
      ctx.lineTo(size * 0.08, size * 0.22);
      ctx.lineTo(size * 0.01, size * 0.22);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      break;
    }
    case "snow": {
      drawCloud(ctx, 0, -size * 0.1, size * 0.38, "#90b0c8");
      ctx.fillStyle = "#ddeeff";
      for (let i = 0; i < 4; i++) {
        const dx = (i / 3 - 0.5) * size * 0.45;
        const dy = size * 0.2 + ((t * 0.002 * rainSpeed + i * 0.28) % 1) * size * 0.22;
        ctx.beginPath();
        ctx.arc(dx, dy, size * 0.05, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "partly_cloudy": {
      const sg2 = ctx.createRadialGradient(
        -size * 0.08, -size * 0.15, 0,
        -size * 0.08, -size * 0.15, size * 0.3,
      );
      sg2.addColorStop(0, "#ffe566");
      sg2.addColorStop(1, "rgba(255,200,0,0)");
      ctx.fillStyle = sg2;
      ctx.beginPath();
      ctx.arc(-size * 0.08, -size * 0.15, size * 0.3, 0, Math.PI * 2);
      ctx.fill();
      drawCloud(ctx, size * 0.08, size * 0.05, size * 0.36, "#b0c8e0");
      break;
    }
    case "cloud_night": {
      // Lua parcialmente atrás das nuvens
      ctx.fillStyle = "#c8dcff";
      ctx.shadowColor = "#8899ff";
      ctx.shadowBlur = size * 0.3;
      ctx.beginPath();
      ctx.arc(-size * 0.18, -size * 0.18, size * 0.26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0a0f1e";
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(-size * 0.06, -size * 0.24, size * 0.2, 0, Math.PI * 2);
      ctx.fill();
      drawCloud(ctx, size * 0.06, size * 0.05, size * 0.44, "#4a5570");
      break;
    }
    case "partly_cloudy_night": {
      ctx.fillStyle = "#c8dcff";
      ctx.shadowColor = "#8899ff";
      ctx.shadowBlur = size * 0.35;
      ctx.beginPath();
      ctx.arc(-size * 0.16, -size * 0.16, size * 0.28, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0a0f1e";
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(-size * 0.04, -size * 0.22, size * 0.21, 0, Math.PI * 2);
      ctx.fill();
      drawCloud(ctx, size * 0.18, size * 0.08, size * 0.36, "#6070a0");
      break;
    }
    case "rain_night": {
      drawCloud(ctx, 0, -size * 0.1, size * 0.38, "#354560");
      ctx.strokeStyle = "#6ab0ff";
      ctx.lineWidth = size * 0.05;
      ctx.globalAlpha = 0.75;
      for (let i = 0; i < 5; i++) {
        const dx = (i / 4 - 0.5) * size * 0.5;
        const dy = size * 0.2 + ((t * 0.004 * rainSpeed + i * 0.25) % 1) * size * 0.25;
        ctx.beginPath();
        ctx.moveTo(dx - size * 0.03, dy);
        ctx.lineTo(dx, dy + size * 0.15);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case "drizzle_night": {
      drawCloud(ctx, 0, -size * 0.1, size * 0.38, "#354560");
      ctx.strokeStyle = "#88aacc";
      ctx.lineWidth = size * 0.04;
      ctx.globalAlpha = 0.65;
      for (let i = 0; i < 3; i++) {
        const dx = (i / 2 - 0.5) * size * 0.45;
        const dy = size * 0.2 + ((t * 0.004 * rainSpeed + i * 0.3) % 1) * size * 0.22;
        ctx.beginPath();
        ctx.moveTo(dx - size * 0.02, dy);
        ctx.lineTo(dx, dy + size * 0.12);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case "storm_night": {
      drawCloud(ctx, 0, -size * 0.1, size * 0.4, "#252e3a");
      ctx.fillStyle = "#ccccff";
      ctx.shadowColor = "#aaaaff";
      ctx.shadowBlur = size * 0.2;
      ctx.beginPath();
      ctx.moveTo(size * 0.05, size * 0.08);
      ctx.lineTo(-size * 0.05, size * 0.26);
      ctx.lineTo(size * 0.02, size * 0.26);
      ctx.lineTo(-size * 0.05, size * 0.44);
      ctx.lineTo(size * 0.08, size * 0.22);
      ctx.lineTo(size * 0.01, size * 0.22);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      break;
    }
    case "fog_night": {
      ctx.fillStyle = "#9aabcc";
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.arc(0, -size * 0.12, size * 0.28, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0a0f1e";
      ctx.beginPath();
      ctx.arc(size * 0.12, -size * 0.18, size * 0.21, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#6677aa";
      ctx.lineWidth = size * 0.08;
      ctx.lineCap = "round";
      for (let i = 0; i < 3; i++) {
        const fy = (i - 1) * size * 0.22;
        const fx = Math.sin(t * 0.0008 + i) * size * 0.06;
        ctx.globalAlpha = 0.25 + i * 0.1;
        ctx.beginPath();
        ctx.moveTo(-size * 0.38 + fx, fy);
        ctx.lineTo(size * 0.38 + fx, fy);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.lineCap = "butt";
      break;
    }
    default:
      drawCloud(ctx, 0, 0, size * 0.44, "#8090a8");
  }

  ctx.restore();
}
