// Belgeden metin çıkarma ve parçalama.
// PDF sayfa sayfa okunur; Word (.docx) ve düz metin dosyalarında sayfa olmadığı için metin yaklaşık bir sayfa
// uzunluğundaki bölümlere ayrılır. Taranmış (resim) PDF'lerde metin çıkmaz; bu durum çağırana bildirilir.
import zlib from 'node:zlib';
import path from 'node:path';

const MAX_UNZIPPED = 300 * 1024 * 1024;
const PSEUDO_PAGE = 3000; // sayfasız belgelerde bir "sayfa"nın yaklaşık uzunluğu (karakter)

export const extOf = (name) => path.extname(String(name || '')).slice(1).toLowerCase();
export const SUPPORTED = ['pdf', 'docx', 'txt', 'md', 'markdown', 'csv', 'json', 'log', 'html', 'htm'];

// ---------- zip (docx bir zip arşividir) ----------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip değil');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    files.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return (method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED })).toString('utf8');
    });
  }
  return files;
}

const unesc = (s) => s.replace(/&(lt|gt|quot|apos|amp|#x?[0-9a-fA-F]+);/g, (m, e) => (
  { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e] ?? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))));

export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    try { return new TextDecoder('windows-1254').decode(buf); } catch { return buf.toString('latin1'); }
  }
}

/** Word belgesinin paragrafları (başlık biçimli paragraflar "# " ile işaretlenir) */
export function docxParagraphs(buf) {
  const xml = unzip(buf).get('word/document.xml')?.();
  if (!xml) throw new Error('Word belgesi okunamadı');
  const out = [];
  for (const m of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const p = m[0];
    const text = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((t) => (t[1] !== undefined ? unesc(t[1]) : ' ')).join('').trim();
    if (!text) continue;
    out.push(/<w:pStyle w:val="(Heading|Balk|Title)[^"]*"/i.test(p) ? `# ${text}` : text);
  }
  return out;
}

/** Paragrafları yaklaşık sayfa uzunluğunda bölümlere toplar */
export function paragraphsToPages(paragraphs, size = PSEUDO_PAGE) {
  const pages = [];
  let cur = '';
  for (const p of paragraphs) {
    if (cur && cur.length + p.length > size) { pages.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + p;
    while (cur.length > size * 2) { pages.push(cur.slice(0, size)); cur = cur.slice(size); } // tek paragraf çok uzunsa
  }
  if (cur.trim()) pages.push(cur);
  return pages.map((text, i) => ({ page: i + 1, text }));
}

async function pdfPages(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const it of content.items) {
        if (typeof it.str !== 'string') continue;
        text += it.str;
        text += it.hasEOL ? '\n' : (it.str && !it.str.endsWith(' ') ? ' ' : '');
      }
      pages.push({ page: n, text: text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim() });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

/**
 * Belgenin sayfaları: [{ page, text }]. paged: sayfa numaraları gerçek mi (PDF) yoksa yaklaşık bölüm mü.
 * Metin çıkmayan belgede (taranmış PDF) "no-text" kodlu hata verir.
 */
export async function extractPages(buf, name) {
  const e = extOf(name);
  let pages;
  let paged = false;
  if (e === 'pdf') { pages = await pdfPages(buf); paged = true; }
  else if (e === 'docx') pages = paragraphsToPages(docxParagraphs(buf));
  else if (e === 'html' || e === 'htm') pages = paragraphsToPages(decodeText(buf).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|h\d|li|tr|br)>|<br\s*\/?>/gi, '\n\n').replace(/<[^>]+>/g, ' ').split(/\n\s*\n/).map((s) => unesc(s).replace(/\s+/g, ' ').trim()).filter(Boolean));
  else if (SUPPORTED.includes(e)) pages = paragraphsToPages(decodeText(buf).split(/\r?\n\s*\r?\n/).map((s) => s.trim()).filter(Boolean));
  else throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
  const chars = pages.reduce((n, p) => n + p.text.length, 0);
  if (chars < 20) throw Object.assign(new Error('no-text'), { code: 'no-text' });
  return { pages, paged, chars };
}

/**
 * Arama parçaları: her sayfa paragraf sınırlarından yaklaşık "size" karakterlik parçalara bölünür; ardışık parçalar
 * bağlam kopmasın diye "overlap" kadar örtüşür. [{ id, page, text }]
 */
export function makeChunks(pages, size = 900, overlap = 150) {
  const chunks = [];
  for (const { page, text } of pages) {
    const parts = text.split(/\n\s*\n|(?<=[.!?…:])\s*\n/).map((s) => s.trim()).filter(Boolean);
    let cur = '';
    const flush = () => { if (cur.trim()) chunks.push({ id: chunks.length, page, text: cur.trim() }); };
    for (let p of parts) {
      while (p.length > size) { // tek paragraf parçadan uzunsa cümle/boşluk sınırından kes
        const cut = Math.max(p.lastIndexOf('. ', size), p.lastIndexOf(' ', size));
        const at = cut > size * 0.5 ? cut + 1 : size;
        if (cur) { flush(); cur = ''; }
        chunks.push({ id: chunks.length, page, text: p.slice(0, at).trim() });
        p = p.slice(Math.max(0, at - overlap));
      }
      if (cur && cur.length + p.length + 1 > size) { flush(); cur = cur.slice(-overlap).replace(/^\S*\s/, ''); }
      cur += (cur ? '\n' : '') + p;
    }
    flush();
  }
  return chunks;
}

/** Anlamlandırma bölümleri: ardışık sayfalar yaklaşık "size" karakterlik bölümlerde toplanır. [{ i, from, to, text }] */
export function makeSections(pages, size = 6000) {
  const sections = [];
  let cur = null;
  for (const { page, text } of pages) {
    if (!text.trim()) continue;
    if (cur && cur.text.length + text.length > size) { sections.push(cur); cur = null; }
    if (!cur) cur = { i: sections.length, from: page, to: page, text: '' };
    cur.to = page;
    cur.text += `${cur.text ? '\n\n' : ''}[s.${page}]\n${text}`;
    while (cur.text.length > size * 1.5) { // tek sayfa çok uzunsa bölünür
      sections.push({ ...cur, text: cur.text.slice(0, size) });
      cur = { i: sections.length, from: page, to: page, text: cur.text.slice(size) };
    }
  }
  if (cur?.text.trim()) sections.push(cur);
  return sections.map((s, i) => ({ ...s, i }));
}
