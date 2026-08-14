/**
 * NewsCard / Weather — Proxy local Node.js
 *
 * Serve os HTMLs do diretório e repassa feeds e imagens externas
 * com CORS habilitado.
 *
 * Como usar:
 *   1. node proxy-server.js
 *   2. Abra http://127.0.0.1:3131/
 *
 * Requisitos: Node.js 18+ (sem dependências externas)
 */

const http  = require('http');
const https = require('https');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');
const net   = require('net');

const PORT = 3131;
const STATIC_DIR = __dirname;

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.map':   'application/json; charset=utf-8',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.webp':  'image/webp',
  '.gif':   'image/gif',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
  '.mp4':   'video/mp4',
  '.webm':  'video/webm',
  '.wasm':  'application/wasm',
};
const STATIC_EXT = new RegExp(`(${Object.keys(MIME).map(e => '\\' + e).join('|')})$`, 'i');

// Hosts permitidos para /feed
const ALLOWED_HOSTS = [
  'api.appnewsdelivery.net',
  'api.hgbrasil.com',
];

// Hosts que devolvem JSON em vez de XML
const JSON_HOSTS = [
  'api.hgbrasil.com',
];

/* ── Bloqueia alvos internos (evita usar o proxy pra varrer a rede local) ── */
function isPrivateTarget(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (net.isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
           (a === 169 && b === 254) ||
           (a === 172 && b >= 16 && b <= 31) ||
           (a === 192 && b === 168) ||
           (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIP(h) === 6) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false;
}

function checkTarget(target) {
  let p;
  try { p = new URL(target); } catch { return 'URL inválida'; }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return `Protocolo não permitido: ${p.protocol}`;
  if (isPrivateTarget(p.hostname)) return `Host interno não permitido: ${p.hostname}`;
  return null;
}

function fetchRemote(targetUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsCardBot/1.0)',
        'Accept':     'application/rss+xml, application/xml, text/xml, application/json, */*',
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Obrigatórios para SharedArrayBuffer (FFmpeg.wasm nos geradores de clima)
  res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const target = parsed.query.url;

  // ── Índice ──────────────────────────────────────────────
  if (parsed.pathname === '/') {
    const pages = fs.readdirSync(STATIC_DIR).filter(f => f.endsWith('.html')).sort();
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(`<!DOCTYPE html><meta charset="utf-8"><title>Geradores</title>
<style>body{background:#2e2e2e;color:#fff;font:15px/1.6 system-ui;padding:40px}
h1{font-size:17px;letter-spacing:1px;color:#5ce3ff;margin-bottom:18px}
a{color:#fff;text-decoration:none;display:block;padding:10px 14px;margin-bottom:6px;
  background:#383838;border:1px solid #4a4a4a;border-radius:6px;max-width:460px}
a:hover{border-color:#5ce3ff;color:#5ce3ff}
p{color:#aaa;font-size:13px;margin-top:20px}</style>
<h1>GERADORES · porta ${PORT}</h1>
${pages.length ? pages.map(f => `<a href="/${f}">${f}</a>`).join('\n')
               : '<p>Nenhum .html neste diretório.</p>'}
<p>Rotas: <code>/feed?url=…</code> · <code>/image?url=…</code> · <code>/health</code></p>`);
    return;
  }

  // ── Arquivos estáticos ──────────────────────────────────
  if (STATIC_EXT.test(parsed.pathname)) {
    const rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    const filepath = path.resolve(STATIC_DIR, rel);

    // impede sair do diretório do proxy
    if (filepath !== STATIC_DIR && !filepath.startsWith(STATIC_DIR + path.sep)) {
      sendJson(res, 403, { error: 'Caminho fora do diretório do proxy' });
      return;
    }
    if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filepath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(filepath).pipe(res);
    } else {
      sendJson(res, 404, { error: `Arquivo não encontrado: ${rel}` });
    }
    return;
  }

  // ── /feed → busca o RSS/JSON ────────────────────────────
  if (parsed.pathname === '/feed') {
    if (!target) return sendJson(res, 400, { error: 'Falta o parâmetro ?url=' });
    const bad = checkTarget(target);
    if (bad) return sendJson(res, 400, { error: bad });

    const host = new URL(target).hostname;
    if (!ALLOWED_HOSTS.includes(host)) {
      return sendJson(res, 403, {
        error: `Host não permitido: ${host}`,
        dica: `Adicione em ALLOWED_HOSTS no proxy-server.js. Liberados: ${ALLOWED_HOSTS.join(', ')}`,
      });
    }
    try {
      console.log(`[proxy] FEED ${target}`);
      const { status, body } = await fetchRemote(target);
      res.writeHead(status, {
        'Content-Type': JSON_HOSTS.includes(host)
          ? 'application/json; charset=utf-8'
          : 'application/xml; charset=utf-8',
      });
      res.end(body);
    } catch (e) {
      console.error(`[proxy] erro no feed: ${e.message}`);
      sendJson(res, 502, { error: e.message });
    }
    return;
  }

  // ── /image → repassa a imagem com CORS ──────────────────
  if (parsed.pathname === '/image') {
    if (!target) return sendJson(res, 400, { error: 'Falta o parâmetro ?url=' });
    const bad = checkTarget(target);
    if (bad) return sendJson(res, 400, { error: bad });

    try {
      const p = new URL(target);
      const lib = p.protocol === 'https:' ? https : http;
      const proxyReq = lib.request({
        hostname: p.hostname,
        port:     p.port || (p.protocol === 'https:' ? 443 : 80),
        path:     p.pathname + p.search,
        method:   'GET',
        headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*,*/*' },
        timeout:  15000,
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type':  proxyRes.headers['content-type'] || 'image/jpeg',
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        proxyRes.pipe(res);
      });
      proxyReq.on('error',   e => { res.writeHead(502); res.end(e.message); });
      proxyReq.on('timeout', () => { proxyReq.destroy(); res.writeHead(504); res.end('Timeout'); });
      proxyReq.end();
    } catch (e) {
      res.writeHead(500); res.end(e.message);
    }
    return;
  }

  // ── Health check ────────────────────────────────────────
  if (parsed.pathname === '/health') {
    return sendJson(res, 200, { ok: true, port: PORT });
  }

  sendJson(res, 404, { error: 'Rota não encontrada', rotas: ['/', '/feed?url=', '/image?url=', '/health'] });
});

server.listen(PORT, '127.0.0.1', () => {
  const pages = fs.readdirSync(STATIC_DIR).filter(f => f.endsWith('.html')).sort();
  console.log('');
  console.log(`  Proxy no ar em http://127.0.0.1:${PORT}/`);
  console.log('');
  pages.forEach(f => console.log(`    http://127.0.0.1:${PORT}/${f}`));
  console.log('');
  console.log('  Ctrl+C para parar');
  console.log('');
});
