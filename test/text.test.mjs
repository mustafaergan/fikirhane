// Metin çıkarma ve parçalama
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPages, paragraphsToPages, makeChunks, makeSections, decodeText } from '../src/text.js';

/** Her sayfasında verilen metin olan küçük bir PDF üretir (testler için) */
export function tinyPdf(texts) {
  const objs = [];
  const kids = texts.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${texts.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  texts.forEach((t, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${t.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objs[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('PDF sayfa sayfa okunur; sayfa numaraları gerçektir', async () => {
  const { pages, paged } = await extractPages(tinyPdf(['Birinci sayfa: siparis iptali kurallari', 'Ikinci sayfa: iade suresi 14 gun']), 'kurallar.pdf');
  assert.equal(paged, true);
  assert.deepEqual(pages.map((p) => p.page), [1, 2]);
  assert.match(pages[0].text, /siparis iptali/);
  assert.match(pages[1].text, /iade suresi 14 gun/);
});

test('metin dosyası yaklaşık sayfa uzunluğunda bölümlere ayrılır; Türkçe karakterler korunur', async () => {
  const para = 'Sipariş iptali için müşteri başvurusu gerekir. '.repeat(20);
  const { pages, paged } = await extractPages(Buffer.from(Array(10).fill(para).join('\n\n'), 'utf8'), 'not.txt');
  assert.equal(paged, false);
  assert.ok(pages.length >= 3, `bölüm sayısı ${pages.length}`);
  assert.ok(pages.every((p) => p.text.length <= 6100));
  assert.match(pages[0].text, /Sipariş iptali için müşteri/);
  assert.equal(decodeText(Buffer.from('şğı', 'utf8')), 'şğı');
});

test('metin çıkmayan ya da desteklenmeyen dosya anlaşılır hata verir', async () => {
  await assert.rejects(extractPages(Buffer.from('   '), 'bos.txt'), { code: 'no-text' });
  await assert.rejects(extractPages(Buffer.from('x'), 'resim.png'), { code: 'unsupported' });
});

test('parçalar sayfa numarasını taşır, boyutu aşmaz ve uzun paragraf bölünür', () => {
  const pages = paragraphsToPages(['# Başlık', 'Kısa paragraf.', 'Uzun cümle burada. '.repeat(120)], 100_000);
  const chunks = makeChunks([{ page: 7, text: pages[0].text }], 500, 80);
  assert.ok(chunks.length >= 4);
  assert.ok(chunks.every((c) => c.page === 7 && c.text.length <= 560), JSON.stringify(chunks.map((c) => c.text.length)));
  assert.deepEqual(chunks.map((c) => c.id), chunks.map((_, i) => i));
  assert.match(chunks[0].text, /Başlık/);
});

test('anlamlandırma bölümleri ardışık sayfaları toplar ve sayfa işaretlerini içerir', () => {
  const pages = Array.from({ length: 10 }, (_, i) => ({ page: i + 1, text: `Sayfa ${i + 1} metni. `.repeat(60) }));
  const sections = makeSections(pages, 3000);
  assert.ok(sections.length >= 3);
  assert.equal(sections[0].from, 1);
  assert.equal(sections.at(-1).to, 10);
  assert.match(sections[0].text, /^\[s\.1\]/);
  for (let i = 1; i < sections.length; i++) assert.ok(sections[i].from >= sections[i - 1].to, 'sıralı');
});
