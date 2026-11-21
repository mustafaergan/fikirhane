// Güncelleme denetimi: depodaki sürüm ne sıklıkla okunur, okunamazsa ne olur. Gerçek depoya gidilmez; sürüm bu
// testin açtığı yerel bir sunucudan (FIKIRHANE_UPDATE_URL) okunur.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const MIN = 60 * 1000;

let version = current; // "depodaki" sürüm
let status = 200;
let hits = 0;
const repo = http.createServer((req, res) => { hits++; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: 'fikirhane', version })); });
await new Promise((r) => repo.listen(0, '127.0.0.1', r));
const repoUrl = `http://127.0.0.1:${repo.address().port}/package.json`;
process.env.FIKIRHANE_UPDATE_URL = repoUrl;
delete process.env.FIKIRHANE_UPDATE_CHECK;

const { checkUpdate, compareVersions, nextDailyAt, startDailyCheck, setSystemGet, resetUpdateCache, systemText } = await import('../src/update.js');
setSystemGet(async () => ''); // testlerde PowerShell'e düşülmez (ayrı testte denenir)
test.after(() => repo.close());

test('sürüm karşılaştırma ve günlük denetim saati', () => {
  assert.ok(compareVersions('0.10.0', '0.9.2') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  const at = new Date(2026, 10, 22, 8, 0).getTime();
  assert.equal(new Date(nextDailyAt(at)).getHours(), 9);
  assert.equal(new Date(nextDailyAt(new Date(2026, 10, 22, 9, 30).getTime())).getDate(), 23);
});

test('güncellemeden sonra çıkan sürüm ertesi günü beklemeden görülür (sonuç yarım saat saklanır)', async () => {
  resetUpdateCache();
  const t0 = Date.UTC(2026, 10, 21, 12, 0);
  // Açılış denetimi: depodaki sürüm kurulu olanla aynı (az önce güncellendi)
  const first = await checkUpdate({ force: true, now: t0 });
  assert.deepEqual([first.current, first.latest, first.available, first.failed], [current, current, false, undefined]);
  // Depoya yeni sürüm gelir. Arayüz birkaç dakika sonra sorarsa saklanan sonuç döner (depo her soruda yoklanmaz)…
  version = '99.0.0';
  const before = hits;
  assert.equal((await checkUpdate({ now: t0 + 10 * MIN })).available, false);
  assert.equal(hits, before, 'yarım saat dolmadan depo yeniden okunmaz');
  // …yarım saat sonra sorduğunda ise yeni sürüm görünür (eskiden ertesi sabah 9'a kadar görünmüyordu)
  const later = await checkUpdate({ now: t0 + 31 * MIN });
  assert.deepEqual([later.latest, later.available], ['99.0.0', true]);
  // Elle denetim saklanan sonuca bakmaz
  version = '99.1.0';
  assert.equal((await checkUpdate({ force: true, now: t0 + 32 * MIN })).latest, '99.1.0');
});

test('depo okunamazsa sonuç bir gün saklanmaz: beş dakika sonra yeniden denenir, görülmüş sürüm unutulmaz', async () => {
  resetUpdateCache();
  const t0 = Date.UTC(2026, 10, 21, 12, 0);
  status = 503;
  const down = await checkUpdate({ force: true, now: t0 });
  assert.deepEqual([down.latest, down.available, down.failed], [null, false, true]);
  let before = hits;
  await checkUpdate({ now: t0 + 2 * MIN });
  assert.equal(hits, before, 'beş dakika dolmadan yeniden denenmez');
  status = 200; version = '99.2.0';
  const up = await checkUpdate({ now: t0 + 6 * MIN });
  assert.deepEqual([up.latest, up.available, up.failed], ['99.2.0', true, undefined]);
  // Sonradan ağ kesilirse bilinen güncelleme düğmesi kaybolmaz
  status = 503;
  const again = await checkUpdate({ force: true, now: t0 + 40 * MIN });
  assert.deepEqual([again.latest, again.available, again.failed], ['99.2.0', true, true]);
  status = 200;
});

test('doğrudan okunamayınca sürüm Windows ağ katmanından sorulur', async () => {
  resetUpdateCache();
  status = 503;
  const asked = [];
  setSystemGet(async (url) => { asked.push(url); return JSON.stringify({ version: '99.3.0' }); });
  const r = await checkUpdate({ force: true, now: Date.UTC(2026, 10, 21, 12, 0) });
  assert.deepEqual([r.latest, r.available, r.failed, asked], ['99.3.0', true, undefined, [repoUrl]]);
  // Doğrudan okuma çalışıyorsa PowerShell hiç başlatılmaz
  status = 200; version = '99.4.0';
  assert.equal((await checkUpdate({ force: true, now: Date.UTC(2026, 10, 21, 13, 0) })).latest, '99.4.0');
  assert.equal(asked.length, 1);
  setSystemGet(async () => '');
});

test('PowerShell ile okuma gerçekten çalışır', { skip: process.platform !== 'win32' }, async () => {
  status = 200; version = '99.5.0';
  assert.equal(JSON.parse(await systemText(repoUrl)).version, '99.5.0');
  assert.equal(await systemText('http://127.0.0.1:9/package.json'), '', 'ulaşılamayan adres boş döner, hata fırlatmaz');
});

test('zamanlı denetim: okunamayınca ertesi sabahı beklemeden, aralığı büyüterek yeniden dener', async () => {
  let clock = new Date(2026, 10, 21, 10, 0).getTime(); // sabah 9 denetimi geçmiş: sıradaki ertesi gün
  let calls = 0;
  let failed = true;
  const stop = startDailyCheck({ check: async () => { calls++; return { failed }; }, now: () => clock, tickMs: 5, firstMs: 0, retryMs: 5 * MIN });
  const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  try {
    await wait();
    assert.equal(calls, 1, 'açılışta bir kez denetler');
    clock += 4 * MIN; await wait();
    assert.equal(calls, 1, 'beş dakika dolmadan yeniden denemez');
    clock += 2 * MIN; await wait();
    assert.equal(calls, 2, 'beş dakika sonra yeniden dener');
    clock += 6 * MIN; await wait();
    assert.equal(calls, 2, 'ikinci bekleme on dakikadır');
    failed = false;
    clock += 5 * MIN; await wait();
    assert.equal(calls, 3);
    clock += 60 * MIN; await wait();
    assert.equal(calls, 3, 'okununca ertesi sabaha kadar yeniden denetlemez');
    clock = new Date(2026, 10, 22, 9, 1).getTime(); await wait();
    assert.equal(calls, 4, 'ertesi sabah 9 denetimi');
  } finally { stop(); }
});
