// Fikirhane sunucusu: yalnızca bu bilgisayardan (127.0.0.1) erişilir. Ek kütüphane kullanmaz.
// Korumalar: başka bir alan adından (DNS yönlendirme) gelen istekler ve bir web sayfasının kullanıcı adına
// gönderdiği istekler reddedilir (Host denetimi + değiştiren isteklerde özel başlık).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from './library.js';
import * as llm from './llm.js';
import { checkUpdate, applyUpdate } from './update.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const MAX_UPLOAD = 300 * 1024 * 1024;

const MESSAGES = {
  'bad-url': 'Geçerli bir adres girin (http://… ile başlamalı, ör. http://localhost:11434)',
  'no-llm': 'Yerel model ayarlı değil. Ayarlar\'dan sunucu adresini ve sohbet modelini girin.',
  'no-embed': 'Anlamsal dizin için Ayarlar\'da bir embedding modeli seçin.',
  'unreachable': 'Yerel model sunucusuna ulaşılamadı. Sunucunun çalıştığını ve adresi kontrol edin.',
  'not-found': 'Bulunamadı.',
  'unsupported': 'Bu dosya türü desteklenmiyor. Desteklenenler: PDF, Word (.docx), metin, Markdown, HTML, CSV.',
  'no-text': 'Bu belgeden metin çıkarılamadı. Taranmış (resim) bir PDF olabilir; metin içeren bir sürümünü yükleyin.',
  'busy': 'Bu belgede zaten bir işlem sürüyor.',
  'empty': 'Bir şey yazın.',
  'too-large': 'Dosya çok büyük (en fazla 300 MB).',
};
const errorText = (err) => MESSAGES[err.code] ? `${MESSAGES[err.code]}${err.detail && err.code !== 'no-text' ? ` (${err.detail})` : ''}` : (err.detail || err.message);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too-large'), { code: 'too-large' })); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

export function createServer({ port = 3310, host = '127.0.0.1' } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const send = (res, code, data) => { const body = JSON.stringify(data); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };

  const routes = [
    ['GET', /^\/api\/config$/, async () => ({ app: 'fikirhane', version, settings: lib.publicSettings(), home: lib.home() })],
    ['POST', /^\/api\/settings$/, async (_m, body) => ({ ok: true, settings: lib.saveSettings(body) })],
    ['POST', /^\/api\/settings\/test$/, async (_m, body) => {
      const cur = lib.settings();
      const cfg = { url: body.url || cur.url, key: body.key || cur.key };
      if (!llm.validUrl(cfg.url)) throw Object.assign(new Error('bad-url'), { code: 'bad-url' });
      const models = await llm.listModels(cfg);
      const out = { ok: true, models, chat: null, embed: null };
      if (body.chatModel) { await llm.chat({ ...cfg, model: body.chatModel, maxTokens: 16, timeoutMs: 120_000, messages: [{ role: 'user', content: 'Merhaba' }] }); out.chat = true; }
      if (body.embedModel) { out.embed = (await llm.embed({ ...cfg, model: body.embedModel, input: ['deneme'], timeoutMs: 120_000 }))[0].length; }
      return out;
    }],
    ['GET', /^\/api\/docs$/, async () => ({ docs: lib.listDocs().map((d) => ({ ...d, job: lib.jobOf(d.id) })) })],
    ['GET', /^\/api\/docs\/([\w-]+)$/, async (m) => { const d = lib.getDocument(m[1]); return { ...d, job: lib.jobOf(m[1]) }; }],
    ['DELETE', /^\/api\/docs\/([\w-]+)$/, async (m) => { lib.removeDocument(m[1]); console.log(`[belge] silindi: ${m[1]}`); return { ok: true }; }],
    ['GET', /^\/api\/docs\/([\w-]+)\/page\/(\d+)$/, async (m) => lib.pageText(m[1], m[2])],
    ['POST', /^\/api\/docs\/([\w-]+)\/understand$/, async (m) => { lib.understand(m[1]); console.log(`[belge] anlamlandırma başladı: ${m[1]}`); return { ok: true, job: lib.jobOf(m[1]) }; }],
    ['POST', /^\/api\/docs\/([\w-]+)\/embed$/, async (m) => { lib.embedDocument(m[1]); return { ok: true, job: lib.jobOf(m[1]) }; }],
    ['POST', /^\/api\/docs\/([\w-]+)\/cancel$/, async (m) => { lib.cancelJob(m[1]); return { ok: true }; }],
    ['POST', /^\/api\/docs\/([\w-]+)\/answer$/, async (m, body) => ({ ok: true, questions: lib.answerQuestion(m[1], Number(body.i), body.answer) })],
    ['POST', /^\/api\/docs\/([\w-]+)\/comment$/, async (m, body) => ({ ok: true, comments: lib.addComment(m[1], body.text) })],
    ['DELETE', /^\/api\/docs\/([\w-]+)\/comment\/([\w-]+)$/, async (m) => ({ ok: true, comments: lib.removeComment(m[1], m[2]) })],
    ['POST', /^\/api\/docs\/([\w-]+)\/map$/, async (m, body) => { lib.saveMap(m[1], body.text); return { ok: true }; }],
    ['POST', /^\/api\/docs\/([\w-]+)\/approve$/, async (m, body) => ({ ok: true, meta: lib.setApproved(m[1], body.approved) })],
    ['POST', /^\/api\/search$/, async (_m, body) => ({ ok: true, results: await lib.search(String(body.q || ''), Array.isArray(body.docs) ? body.docs : [], 12) })],
    ['POST', /^\/api\/ask$/, async (_m, body) => { const started = Date.now(); const r = await lib.ask(body.q, Array.isArray(body.docs) ? body.docs : []); console.log(`[soru] yanıtlandı: ${r.sources.length} kaynak, ${Math.round((Date.now() - started) / 1000)} sn`); return { ok: true, ...r }; }],
    ['GET', /^\/api\/update$/, async (_m, _b, url) => checkUpdate({ force: url.searchParams.get('refresh') === '1' })],
    ['POST', /^\/api\/update\/apply$/, async () => applyUpdate()],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // Yalnızca yerel adla gelen istekler kabul edilir (başka bir alan adını bu bilgisayara yönlendiren sayfalara karşı)
    const hostName = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostName)) { res.writeHead(403); return res.end('Yalnızca bu bilgisayardan erişilir'); }
    try {
      if (url.pathname.startsWith('/api/')) {
        // Değiştiren isteklerde özel başlık: başka bir web sayfası bu başlığı gönderemez
        if (req.method !== 'GET' && req.headers['x-fikirhane'] !== '1') return send(res, 403, { ok: false, error: 'İstek reddedildi' });
        if (req.method === 'POST' && url.pathname === '/api/docs') {
          const name = decodeURIComponent(String(req.headers['x-dosya-adi'] || 'belge'));
          const meta = await lib.addDocument(await readBody(req, MAX_UPLOAD), name);
          console.log(`[belge] eklendi: ${meta.pages} sayfa, ${meta.chunks} parça`);
          return send(res, 200, { ok: true, meta });
        }
        for (const [method, re, fn] of routes) {
          const m = req.method === method && re.exec(url.pathname);
          if (!m) continue;
          const raw = method === 'GET' ? null : await readBody(req, 2 * 1024 * 1024);
          let body = {};
          if (raw?.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { ok: false, error: 'Geçersiz istek' }); } }
          return send(res, 200, await fn(m, body, url));
        }
        return send(res, 404, { ok: false, error: 'Bulunamadı' });
      }
      // Statik dosyalar
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Bulunamadı'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      if (!res.headersSent) send(res, 200, { ok: false, error: errorText(err), code: err.code || '' });
    }
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server)); });
}
