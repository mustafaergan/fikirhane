// Fikirhane sunucusu: yalnızca bu bilgisayardan (127.0.0.1) erişilir. Ek kütüphane kullanmaz.
// Korumalar: başka bir alan adından (DNS yönlendirme) gelen istekler ve bir web sayfasının kullanıcı adına
// gönderdiği istekler reddedilir (Host denetimi + değiştiren isteklerde özel başlık).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from './library.js';
import * as llm from './llm.js';
import * as gezgin from './gezgin.js';
import { checkUpdate, applyUpdate } from './update.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const MAX_UPLOAD = 300 * 1024 * 1024;

const MESSAGES = {
  'bad-url': 'Geçerli bir adres girin (http://… ile başlamalı, ör. http://localhost:11434)',
  'no-llm': 'Yerel model ayarlı değil. Ayarlar\'dan sunucu adresini ve sohbet modelini girin.',
  'no-atolye-model': 'Seçili Atölye modeli bulunamadı; Atölye tarafında silinmiş olabilir. Ayarlar penceresinden yeniden seçin.',
  'no-embed': 'Anlamsal dizin için Ayarlar\'da bir embedding modeli seçin.',
  'unreachable': 'Yerel model sunucusuna ulaşılamadı. Sunucunun çalıştığını ve adresi kontrol edin.',
  'not-found': 'Bulunamadı.',
  'unsupported': 'Bu dosya türü desteklenmiyor. Desteklenenler: PDF, Word (.docx), metin, Markdown, HTML, CSV.',
  'no-text': 'Bu belgeden metin çıkarılamadı. Taranmış (resim) bir PDF olabilir; metin içeren bir sürümünü yükleyin.',
  'busy': 'Bu belgede zaten bir işlem sürüyor.',
  'empty': 'Bir şey yazın.',
  'too-large': 'Dosya çok büyük (en fazla 300 MB).',
  'nothing-to-export': 'Dışa aktarılacak yerel model ayarı yok. Önce sunucu adresini ve sohbet modelini kaydedin.',
  'bad-file': 'Bu dosya bir Fikirhane ya da Atölye yerel model dosyası değil ya da bozuk.',
  'need-pass': 'Dosyada şifreli API anahtarı var; şifreleme anahtarını yazın.',
  'bad-pass': 'Şifreleme anahtarı yanlış; dosyadaki API anahtarı çözülemedi. Hiçbir şey değiştirilmedi.',
  'bad-site': 'Geçerli bir site adresi girin (ör. https://uygulama.example.com).',
  'no-browser': 'Bu bilgisayarda Microsoft Edge ya da Google Chrome bulunamadı.',
  'browser-failed': 'Tarayıcı başlatılamadı.',
  'tour-busy': 'Zaten süren bir gezinti var. Önce onu bitirin ya da ondan vazgeçin.',
  'no-tour': 'Süren bir gezinti yok.',
  'tour-closed': 'Tarayıcı penceresi kapanmış. Kaydedilen ekranları "Bitir ve kaydet" ile saklayabilirsiniz.',
  'no-name': 'Senaryoya bir ad verin.',
  'no-steps': 'Senaryoda en az bir adım olmalı.',
  'too-many-steps': 'Senaryo çok uzun (en fazla 60 adım). Daha küçük senaryolara bölün.',
  'too-many-scenarios': 'Bu site için çok fazla senaryo var (en fazla 40). Kullanılmayanları silin.',
  'bad-step': 'Senaryo adımı geçersiz.',
  'bad-locator': 'Seçici anlaşılamadı. Örnek: getByRole(\'button\', { name: \'Kaydet\' })',
  'secret-literal': 'Parola alanına sabit değer yazılamaz (senaryo dosyada açık durur). Değer yerine {{parola}} gibi bir değişken kullanın; çalıştırırken FIKIRHANE_VAR_PAROLA ile verilir.',
  'no-route': 'Bu ekrana gidiş yolundaki bir tıklamanın seçicisi bilinmiyor; senaryo üretilemedi.',
  'other-site': 'Güncellenecek kayıt bu siteye ait değil.',
  'no-screens': 'Henüz hiç ekran kaydedilmedi. Açılan tarayıcıda siteyi gezin.',
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

  // Süren gezinti: aynı site daha önce gezildiyse kayıtları da verilir (bitirirken "var olanı güncelle" seçeneği için)
  const tourView = () => { const t = gezgin.tourStatus(); return t ? { ...t, existing: lib.sitesAt(t.origin) } : null; };
  const routes = [
    ['GET', /^\/api\/config$/, async () => ({ app: 'fikirhane', version, settings: lib.publicSettings(), atolye: lib.atolyeList(), home: lib.home() })],
    ['POST', /^\/api\/settings$/, async (_m, body) => ({ ok: true, settings: lib.saveSettings(body) })],
    ['POST', /^\/api\/settings\/export$/, async (_m, body) => { const file = lib.exportSettings(body); console.log('[ayarlar] yerel model ayarı dışa aktarıldı'); return { ok: true, file }; }],
    ['POST', /^\/api\/settings\/import$/, async (_m, body) => { const r = lib.importSettings(body); if (r.settings) console.log('[ayarlar] yerel model ayarı içe aktarıldı'); return { ok: true, ...r }; }],
    ['POST', /^\/api\/settings\/test$/, async (_m, body) => {
      const cfg = lib.draftSettings(body); // elle girilen adres ya da seçilen Atölye modeli
      let models = [];
      // Model listesi sunmayan sunucular (bazı gateway'ler) için: sohbet modeli belliyse liste hatası denemeyi durdurmaz
      try { models = await llm.listModels(cfg); } catch (err) { if (err.code === 'unreachable' || !cfg.chatModel) throw err; }
      const out = { ok: true, models, chat: null, embed: null };
      if (cfg.chatModel) { await llm.chat({ ...cfg, model: cfg.chatModel, maxTokens: 16, timeoutMs: 120_000, messages: [{ role: 'user', content: 'Merhaba' }] }); out.chat = true; }
      if (cfg.embedModel) { out.embed = (await llm.embed({ ...cfg, model: cfg.embedModel, input: ['deneme'], timeoutMs: 120_000 }))[0].length; }
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
    // Site gezintisi: ayrı bir tarayıcı penceresi açılır, ekranlar kart olarak kaydedilir, bitince belge olur
    ['GET', /^\/api\/docs\/([\w-]+)\/screens$/, async (m) => lib.screens(m[1])],
    // Siteler (salt okunur): tarayıcı testi yapacak araçlar ekranı keşfetmek yerine buradan sorar
    ['GET', /^\/api\/sites$/, async () => lib.listSites()],
    ['GET', /^\/api\/sites\/find$/, async (_m, _b, url) => lib.siteFind(url.searchParams.get('q'), url.searchParams.get('site') || '')],
    ['GET', /^\/api\/sites\/([\w-]+)$/, async (m) => lib.siteOverview(m[1])],
    ['GET', /^\/api\/sites\/([\w-]+)\/screens\/(\d+)$/, async (m) => lib.siteScreen(m[1], m[2])],
    ['GET', /^\/api\/sites\/([\w-]+)\/route\/(\d+)$/, async (m) => lib.siteRoute(m[1], m[2])],
    // Senaryolar: saklanır, Playwright betiği olarak verilir; betiği çalıştıran sonucu "result" ucuna bildirir
    ['GET', /^\/api\/sites\/([\w-]+)\/scenarios$/, async (m) => lib.listScenarios(m[1])],
    ['POST', /^\/api\/sites\/([\w-]+)\/scenarios$/, async (m, body) => { const r = lib.saveScenario(m[1], body); console.log(`[senaryo] kaydedildi: ${r.scenario.id} (${r.scenario.steps.length} adım)`); return { ok: true, ...r }; }],
    ['POST', /^\/api\/sites\/([\w-]+)\/scenarios\/from-screen$/, async (m, body) => ({ ok: true, ...lib.scenarioFromScreen(m[1], body.no) })],
    ['GET', /^\/api\/sites\/([\w-]+)\/scenarios\/([\w-]+)$/, async (m) => lib.getScenario(m[1], m[2])],
    ['DELETE', /^\/api\/sites\/([\w-]+)\/scenarios\/([\w-]+)$/, async (m) => { lib.removeScenario(m[1], m[2]); return { ok: true }; }],
    ['GET', /^\/api\/sites\/([\w-]+)\/scenarios\/([\w-]+)\/script$/, async (m, _b, _u, req) => lib.scriptOf(m[1], m[2], { base: `http://${req.headers.host}`, version })],
    ['POST', /^\/api\/sites\/([\w-]+)\/scenarios\/([\w-]+)\/result$/, async (m, body) => { const r = lib.recordRun(m[1], m[2], body); console.log(`[senaryo] ${m[2]}: ${r.status}${r.changed ? `, Ekran ${r.changed} değişmiş` : ''}`); return { ok: true, ...r }; }],
    ['GET', /^\/api\/tour$/, async () => ({ tour: tourView(), browser: Boolean(gezgin.findBrowser()) })],
    ['POST', /^\/api\/tour$/, async (_m, body) => { await gezgin.startTour({ url: body.url }); console.log('[gezinti] başladı'); return { ok: true, tour: tourView() }; }],
    ['POST', /^\/api\/tour\/capture$/, async () => ({ ok: true, ...await gezgin.captureNow(), tour: tourView() })],
    ['POST', /^\/api\/tour\/crawl$/, async (_m, body) => { gezgin.crawlTour({ limit: body.limit }); return { ok: true, tour: tourView() }; }],
    ['POST', /^\/api\/tour\/stop$/, async () => { gezgin.stopCrawl(); return { ok: true, tour: tourView() }; }],
    ['POST', /^\/api\/tour\/finish$/, async (_m, body) => {
      // Güncellenecek kayıt tarayıcı kapanmadan önce denetlenir: hata olursa kaydedilen ekranlar kaybolmaz
      const t = gezgin.tourStatus();
      if (body.update && t && !lib.sitesAt(t.origin).some((x) => x.id === body.update)) throw Object.assign(new Error('other-site'), { code: 'other-site' });
      const done = await gezgin.finishTour();
      if (body.update) { const r = lib.updateSite(body.update, done); console.log(`[gezinti] kayıt güncellendi: ${r.added} yeni, ${r.revised} değişen, ${r.unseen} görülmeyen ekran`); return { ok: true, updated: true, meta: r.meta, text: r.text }; }
      const meta = lib.addSite(done);
      console.log(`[gezinti] bitti: ${meta.pages} ekran, ${meta.chunks} parça`);
      return { ok: true, meta };
    }],
    ['POST', /^\/api\/docs\/([\w-]+)\/screens\/prune$/, async (m) => ({ ok: true, ...lib.pruneScreens(m[1]) })],
    ['POST', /^\/api\/tour\/cancel$/, async () => { await gezgin.cancelTour(); return { ok: true }; }],
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
          return send(res, 200, await fn(m, body, url, req));
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
