// Kitaplık: belgelerin diskteki hâli ve üzerlerindeki işler.
// Her belge ~/.fikirhane/belgeler/<kimlik>/ altında düz dosyalar olarak durur (elle okunup düzeltilebilir):
//   meta.json      ad, sayfa sayısı, durum
//   sayfalar.json  çıkarılan metin (sayfa sayfa)
//   parcalar.json  arama parçaları
//   vektorler.bin  (varsa) parçaların embedding vektörleri
//   notlar.json    bölüm notları (yerel modelin çıkardığı)
//   harita.md      belgenin bir sayfalık haritası
//   sorular.json   modelin kullanıcıya sorduğu sorular ve yanıtları
//   yorumlar.json  kullanıcının kendi notları (belgeden çıkan bilgiden ayrı tutulur)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractPages, makeChunks, makeSections, extOf, SUPPORTED } from './text.js';
import { buildIndex, bm25, cosineTop, fuse } from './search.js';
import * as llm from './llm.js';

export const home = () => process.env.FIKIRHANE_HOME || path.join(os.homedir(), '.fikirhane');
const docsDir = () => path.join(home(), 'belgeler');
const dirOf = (id) => path.join(docsDir(), String(id).replace(/[^\w-]/g, ''));
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 1)); };
const safeName = (name) => String(name || 'belge').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 150) || 'belge';

// ---------- Ayarlar (yerel model sunucusu) ----------
const settingsFile = () => path.join(home(), 'ayarlar.json');
export function settings() {
  const s = readJson(settingsFile(), {});
  return { url: s.url || '', chatModel: s.chatModel || '', embedModel: s.embedModel || '', key: s.key || '' };
}
export const publicSettings = () => { const s = settings(); return { url: s.url, chatModel: s.chatModel, embedModel: s.embedModel, hasKey: Boolean(s.key), ready: Boolean(s.url && s.chatModel) }; };
export function saveSettings({ url, chatModel, embedModel, key } = {}) {
  const u = String(url || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!llm.validUrl(u)) throw fail('bad-url');
  const old = settings();
  writeJson(settingsFile(), { url: u, chatModel: String(chatModel || '').trim(), embedModel: String(embedModel || '').trim(), key: String(key || '').trim() || old.key });
  return publicSettings();
}

// ---------- Belgeler ----------
const metaOf = (id) => readJson(path.join(dirOf(id), 'meta.json'), null);
const saveMeta = (meta) => writeJson(path.join(dirOf(meta.id), 'meta.json'), meta);
const part = (id, name, fallback) => readJson(path.join(dirOf(id), name), fallback);

export function listDocs() {
  let ids = [];
  try { ids = fs.readdirSync(docsDir()); } catch { return []; }
  return ids.map(metaOf).filter(Boolean).sort((a, b) => String(b.added).localeCompare(String(a.added)));
}

const indexCache = new Map(); // belge kimliği → { index, chunks, vectors, dim }
function loaded(id) {
  if (indexCache.has(id)) return indexCache.get(id);
  const chunks = part(id, 'parcalar.json', []);
  const entry = { chunks, index: buildIndex(chunks), vectors: null, dim: 0 };
  const meta = metaOf(id);
  if (meta?.embedDim) {
    try {
      const buf = fs.readFileSync(path.join(dirOf(id), 'vektorler.bin'));
      entry.vectors = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
      entry.dim = meta.embedDim;
    } catch { /* vektör yoksa yalnızca kelime araması */ }
  }
  indexCache.set(id, entry);
  return entry;
}

/** Belge ekler: metin çıkarılır, parçalanır ve kelime dizini hazır olur (yapay zekâ kullanılmaz) */
export async function addDocument(buf, name) {
  const e = extOf(name);
  if (!SUPPORTED.includes(e)) throw fail('unsupported', { ext: e });
  const { pages, paged, chars } = await extractPages(buf, name);
  const id = crypto.randomBytes(5).toString('hex');
  const chunks = makeChunks(pages);
  const meta = { id, name: safeName(name), ext: e, added: new Date().toISOString(), pages: pages.length, paged, chars, chunks: chunks.length, sections: makeSections(pages).length, state: 'dizinlendi', understood: 0, approved: false, embedDim: 0 };
  writeJson(path.join(dirOf(id), 'sayfalar.json'), pages);
  writeJson(path.join(dirOf(id), 'parcalar.json'), chunks);
  fs.writeFileSync(path.join(dirOf(id), `asil.${e}`), buf);
  saveMeta(meta);
  return meta;
}

export function removeDocument(id) {
  if (!metaOf(id)) throw fail('not-found');
  cancelJob(id);
  indexCache.delete(id);
  fs.rmSync(dirOf(id), { recursive: true, force: true });
}

/** Belgenin ayrıntısı: harita, bölüm notları, sorular, kullanıcının yorumları ve süren iş */
export function getDocument(id) {
  const meta = metaOf(id);
  if (!meta) throw fail('not-found');
  let map = '';
  try { map = fs.readFileSync(path.join(dirOf(id), 'harita.md'), 'utf8'); } catch { /* henüz yok */ }
  return { meta, map, notes: part(id, 'notlar.json', []), questions: part(id, 'sorular.json', []), comments: part(id, 'yorumlar.json', []), job: jobs.get(id) || null };
}

export function pageText(id, page) {
  const p = part(id, 'sayfalar.json', []).find((x) => x.page === Number(page));
  if (!p) throw fail('not-found');
  return p;
}

// ---------- Kullanıcının katkıları ----------
export function answerQuestion(id, i, answer) {
  const qs = part(id, 'sorular.json', []);
  if (!qs[i]) throw fail('not-found');
  qs[i].answer = String(answer || '').trim().slice(0, 4000);
  writeJson(path.join(dirOf(id), 'sorular.json'), qs);
  return qs;
}
export function addComment(id, text) {
  if (!metaOf(id)) throw fail('not-found');
  const t = String(text || '').trim().slice(0, 4000);
  if (!t) throw fail('empty');
  const list = part(id, 'yorumlar.json', []);
  list.push({ id: crypto.randomBytes(4).toString('hex'), text: t, added: new Date().toISOString() });
  writeJson(path.join(dirOf(id), 'yorumlar.json'), list);
  return list;
}
export function removeComment(id, commentId) {
  const list = part(id, 'yorumlar.json', []).filter((c) => c.id !== commentId);
  writeJson(path.join(dirOf(id), 'yorumlar.json'), list);
  return list;
}
export function saveMap(id, text) {
  if (!metaOf(id)) throw fail('not-found');
  fs.writeFileSync(path.join(dirOf(id), 'harita.md'), String(text || '').slice(0, 60_000));
}
export function setApproved(id, approved) {
  const meta = metaOf(id);
  if (!meta) throw fail('not-found');
  meta.approved = Boolean(approved);
  saveMeta(meta);
  return meta;
}

// ---------- Arka plan işleri (anlamlandırma, embedding) ----------
const jobs = new Map(); // belge kimliği → { kind, done, total, state, error, controller }
export const jobOf = (id) => { const j = jobs.get(id); return j ? { kind: j.kind, done: j.done, total: j.total, state: j.state, error: j.error || '' } : null; };
export function cancelJob(id) {
  const j = jobs.get(id);
  if (j?.state === 'running') { j.state = 'cancelled'; j.controller.abort(); }
}
function startJob(id, kind, total, run) {
  if (jobs.get(id)?.state === 'running') throw fail('busy');
  const job = { kind, done: 0, total, state: 'running', error: '', controller: new AbortController() };
  jobs.set(id, job);
  job.promise = run(job).then(() => { if (job.state === 'running') job.state = 'done'; }, (err) => {
    if (job.state !== 'cancelled') { job.state = 'error'; job.error = err.detail || err.message; console.warn(`[iş] ${kind} ${id}: ${job.error}`); }
  });
  return job;
}

const PROMPT = {
  note: 'Bir belgenin bir bölümünü okuyorsun. Görevin bu bölümü, sonradan sorulara kaynak olacak şekilde nota çevirmek.\n'
    + 'Kurallar: Yalnızca metinde yazanı kullan, tahmin ekleme. Her maddenin sonuna geçtiği sayfayı (s.N) yaz. Türkçe yaz.\n'
    + 'Biçim:\n**Konu:** tek cümle\n**Öz:** 3–6 madde\n**Kurallar ve kararlar:** varsa maddeler (yoksa "yok")\n**Terimler:** varsa "terim: anlamı" (yoksa "yok")',
  group: 'Aşağıda bir belgenin ardışık bölümlerinin notları var. Bunları, ayrıntıyı kaybetmeden tek bir özet nota indir. Sayfa numaralarını (s.N) koru. Türkçe yaz.',
  map: 'Aşağıda bir belgenin bölüm notları var. Bu belgenin bir sayfalık haritasını çıkar. Yalnızca notlarda yazanı kullan. Türkçe yaz.\n'
    + 'Biçim:\n# Belgenin konusu ve amacı (2–3 cümle)\n# Ana başlıklar (her biri bir satır, sayfa aralığıyla)\n# En önemli kurallar ve kararlar (sayfa numarasıyla)\n# Temel terimler\n# Belirsiz ya da çelişkili görünen noktalar',
  questions: 'Aşağıda bir belgenin haritası var. Bu belgeyi doğru yorumlayabilmek için belgenin sahibine sorulması gereken en fazla 6 soru yaz: '
    + 'belirsiz kalan noktalar, çelişkili görünen yerler, hangi bölümün güncel/geçerli olduğu, kullanıcı için neyin önemli olduğu. '
    + 'Yalnızca bir JSON dizisi döndür: ["soru 1", "soru 2"]. Başka hiçbir şey yazma.',
  answer: 'Sen Fikirhane\'sin: kullanıcının belgelerine dayanarak soru yanıtlarsın.\n'
    + 'Kurallar: Yalnızca aşağıda verilen kaynakları kullan. Her bilginin yanına kaynağını [belge adı s.N] biçiminde yaz. '
    + '"Kullanıcının notları" bölümü belgeden değil kullanıcıdan gelir; belgeyle çelişirse kullanıcının notunu esas al ve bunu belirt. '
    + 'Kaynaklarda yanıt yoksa "Belgelerde bu bilgi yok" de, tahmin yürütme. Kısa ve açık yaz, Türkçe yanıtla.',
};

function parseQuestions(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try { const a = JSON.parse(text.slice(start, end + 1)); if (Array.isArray(a)) return a.filter((q) => typeof q === 'string' && q.trim()).slice(0, 6); } catch { /* aşağıdaki yedek */ }
  }
  return text.split('\n').map((l) => l.replace(/^[\s\-*\d.)"]+|["',]+$/g, '').trim()).filter((l) => l.endsWith('?')).slice(0, 6);
}

/** Yerel modelle anlamlandırma: bölüm notları → harita → kullanıcıya sorular. Kaldığı yerden devam eder. */
export function understand(id) {
  const meta = metaOf(id);
  if (!meta) throw fail('not-found');
  const cfg = settings();
  if (!cfg.url || !cfg.chatModel) throw fail('no-llm');
  const sections = makeSections(part(id, 'sayfalar.json', []));
  const ask = (system, user, signal, maxTokens) => llm.chat({ url: cfg.url, key: cfg.key, model: cfg.chatModel, signal, maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
  return startJob(id, 'anlamlandırma', sections.length + 2, async (job) => {
    const notes = part(id, 'notlar.json', []);
    for (const s of sections) {
      if (job.state !== 'running') return;
      if (!notes.some((n) => n.i === s.i)) {
        const note = await ask(PROMPT.note, `Belge: ${meta.name}\nSayfalar: ${s.from}–${s.to}\n\n${s.text}`, job.controller.signal, 900);
        notes.push({ i: s.i, from: s.from, to: s.to, note });
        notes.sort((a, b) => a.i - b.i);
        writeJson(path.join(dirOf(id), 'notlar.json'), notes);
        const m = metaOf(id); m.understood = notes.length; m.state = 'anlamlandırılıyor'; saveMeta(m);
      }
      job.done++;
    }
    // Harita: notlar modelin bağlamına sığmayacak kadar uzunsa önce gruplar hâlinde özetlenir
    let pieces = notes.map((n) => `[s.${n.from}–${n.to}]\n${n.note}`);
    while (pieces.join('\n\n').length > 14_000 && pieces.length > 1) {
      const groups = [];
      let cur = '';
      for (const p of pieces) { if (cur && cur.length + p.length > 9000) { groups.push(cur); cur = ''; } cur += (cur ? '\n\n' : '') + p; }
      if (cur) groups.push(cur);
      if (groups.length === pieces.length) break;
      pieces = [];
      for (const g of groups) { if (job.state !== 'running') return; pieces.push(await ask(PROMPT.group, g, job.controller.signal, 1000)); }
    }
    const map = await ask(PROMPT.map, `Belge: ${meta.name} (${meta.pages} sayfa)\n\n${pieces.join('\n\n').slice(0, 16_000)}`, job.controller.signal, 1400);
    saveMap(id, map);
    job.done++;
    const old = part(id, 'sorular.json', []);
    if (!old.length) {
      const qs = parseQuestions(await ask(PROMPT.questions, map, job.controller.signal, 600));
      writeJson(path.join(dirOf(id), 'sorular.json'), qs.map((q) => ({ q, answer: '' })));
    }
    job.done++;
    const m = metaOf(id); m.state = 'anlamlandırıldı'; m.understood = notes.length; saveMeta(m);
  });
}

/** Anlamsal dizin: parçaların embedding vektörleri yerel modelden alınır (isteğe bağlı) */
export function embedDocument(id) {
  const meta = metaOf(id);
  if (!meta) throw fail('not-found');
  const cfg = settings();
  if (!cfg.url || !cfg.embedModel) throw fail('no-embed');
  const chunks = part(id, 'parcalar.json', []);
  return startJob(id, 'anlamsal dizin', chunks.length, async (job) => {
    const rows = [];
    for (let i = 0; i < chunks.length; i += 16) {
      if (job.state !== 'running') return;
      const batch = chunks.slice(i, i + 16);
      rows.push(...await llm.embed({ url: cfg.url, key: cfg.key, model: cfg.embedModel, input: batch.map((c) => c.text), signal: job.controller.signal }));
      job.done = Math.min(chunks.length, i + batch.length);
    }
    const dim = rows[0].length;
    const all = new Float32Array(rows.length * dim);
    rows.forEach((r, i) => all.set(r, i * dim));
    fs.writeFileSync(path.join(dirOf(id), 'vektorler.bin'), Buffer.from(all.buffer));
    const m = metaOf(id); m.embedDim = dim; m.embedModel = cfg.embedModel; saveMeta(m);
    indexCache.delete(id);
  });
}

// ---------- Arama ve soru yanıtlama ----------
/** Seçili belgelerde (boşsa hepsinde) arar: kelime araması + varsa anlamsal arama. [{ doc, name, page, text }] */
export async function search(q, docIds = [], limit = 8) {
  const docs = listDocs().filter((d) => !docIds.length || docIds.includes(d.id));
  const cfg = settings();
  let qvec = null;
  const lists = [[], []];
  for (const d of docs) {
    const e = loaded(d.id);
    for (const r of bm25(e.index, q, 20)) lists[0].push({ doc: d.id, name: d.name, page: e.chunks[r.i].page, text: e.chunks[r.i].text, i: r.i, score: r.score });
    if (e.vectors && cfg.url && cfg.embedModel && d.embedModel === cfg.embedModel) {
      try {
        if (!qvec) qvec = (await llm.embed({ url: cfg.url, key: cfg.key, model: cfg.embedModel, input: [q], timeoutMs: 30_000 }))[0];
        if (qvec.length === e.dim) for (const r of cosineTop(e.vectors, e.dim, qvec, 20)) lists[1].push({ doc: d.id, name: d.name, page: e.chunks[r.i].page, text: e.chunks[r.i].text, i: r.i, score: r.score });
      } catch { /* anlamsal arama yapılamazsa kelime aramasıyla devam edilir */ }
    }
  }
  lists.forEach((l) => l.sort((a, b) => b.score - a.score));
  return fuse(lists.filter((l) => l.length), (x) => `${x.doc}:${x.i}`, limit).map(({ doc, name, page, text }) => ({ doc, name, page, text }));
}

/** Soruyu belgelere dayanarak yanıtlar: harita + kullanıcının notları + en ilgili parçalar yerel modele verilir */
export async function ask(q, docIds = []) {
  const question = String(q || '').trim();
  if (!question) throw fail('empty');
  const cfg = settings();
  if (!cfg.url || !cfg.chatModel) throw fail('no-llm');
  const sources = await search(question, docIds, 8);
  const docs = listDocs().filter((d) => (docIds.length ? docIds.includes(d.id) : sources.some((s) => s.doc === d.id)));
  const maps = [];
  const mine = [];
  for (const d of docs.slice(0, 4)) {
    const full = getDocument(d.id);
    if (full.map) maps.push(`## ${d.name}${d.approved ? ' (kullanıcı onayladı)' : ''}\n${full.map.slice(0, 2500)}`);
    for (const x of full.questions) if (x.answer) mine.push(`- (${d.name}) Soru: ${x.q}\n  Kullanıcının yanıtı: ${x.answer}`);
    for (const c of full.comments) mine.push(`- (${d.name}) ${c.text}`);
  }
  const context = [
    maps.length ? `# Belge haritaları\n${maps.join('\n\n')}` : '',
    mine.length ? `# Kullanıcının notları (belgeden değil, kullanıcıdan)\n${mine.join('\n').slice(0, 4000)}` : '',
    sources.length ? `# Kaynak parçalar\n${sources.map((s) => `[${s.name} s.${s.page}]\n${s.text}`).join('\n\n')}` : '# Kaynak parçalar\n(Soruyla eşleşen bölüm bulunamadı.)',
  ].filter(Boolean).join('\n\n');
  const answer = await llm.chat({ url: cfg.url, key: cfg.key, model: cfg.chatModel, maxTokens: 1200, messages: [{ role: 'system', content: PROMPT.answer }, { role: 'user', content: `${context}\n\n# Soru\n${question}` }] });
  return { answer, sources };
}
