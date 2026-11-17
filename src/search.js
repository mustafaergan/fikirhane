// Arama: kelime araması (BM25) ve, varsa, anlamsal arama (embedding vektörleri). İkisi birlikteyse sonuçlar
// sıra birleştirme (reciprocal rank fusion) ile harmanlanır. Ek kütüphane ya da veritabanı kullanılmaz.

/** Büyük/küçük harf ve Türkçe I/İ/ı farkını gidermek için */
export const fold = (s) => String(s).replace(/[İIı]/g, 'i').toLowerCase();

const STOP = new Set('ve veya ile bir bu şu o da de ki mi mı mu mü için gibi ama fakat ancak çok daha en her ne nasıl olan olarak ise the a an of to in and or is are for on with as by at be this that it'.split(' '));

/**
 * Metni aranabilir kelimelere çevirir. Türkçe sondan eklemeli olduğu için ("siparişlerin", "siparişi") uzun
 * kelimeler ilk 6 harfine kısaltılır; böylece aynı kökün çekimli hâlleri eşleşir. Sayı ve kodlar olduğu gibi kalır.
 */
export function tokens(text) {
  const out = [];
  for (const w of fold(text).match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) || []) {
    if (STOP.has(w)) continue;
    out.push(/\d/.test(w) || w.length <= 6 ? w : w.slice(0, 6));
  }
  return out;
}

/** Parçalardan kelime dizini: { n, avg, df: Map(kelime→parça sayısı), docs: [{ len, tf: Map }] } */
export function buildIndex(chunks) {
  const df = new Map();
  const docs = chunks.map((c) => {
    const tf = new Map();
    const t = tokens(c.text);
    for (const w of t) tf.set(w, (tf.get(w) || 0) + 1);
    for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    return { len: t.length, tf };
  });
  const total = docs.reduce((n, d) => n + d.len, 0);
  return { n: docs.length, avg: docs.length ? total / docs.length : 0, df, docs };
}

/** BM25 puanları: [{ i, score }] (en iyi önce) */
export function bm25(index, query, limit = 20, k1 = 1.4, b = 0.75) {
  const q = [...new Set(tokens(query))];
  const out = [];
  if (!q.length || !index.n) return out;
  for (let i = 0; i < index.docs.length; i++) {
    const d = index.docs[i];
    let score = 0;
    for (const w of q) {
      const f = d.tf.get(w);
      if (!f) continue;
      const idf = Math.log(1 + (index.n - index.df.get(w) + 0.5) / (index.df.get(w) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.len / (index.avg || 1))));
    }
    if (score > 0) out.push({ i, score });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

/** Vektör benzerliği (kosinüs): vectors tek bir Float32Array, her parça "dim" uzunluğunda. [{ i, score }] */
export function cosineTop(vectors, dim, queryVec, limit = 20) {
  const n = Math.floor(vectors.length / dim);
  let qn = 0;
  for (let j = 0; j < dim; j++) qn += queryVec[j] * queryVec[j];
  qn = Math.sqrt(qn) || 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    let dot = 0;
    let vn = 0;
    const o = i * dim;
    for (let j = 0; j < dim; j++) { const v = vectors[o + j]; dot += v * queryVec[j]; vn += v * v; }
    out.push({ i, score: dot / (qn * (Math.sqrt(vn) || 1)) });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

/** İki sıralı listeyi sıra birleştirmeyle harmanlar: iki aramada da üstte çıkan parça öne geçer. key(x) eşsiz anahtar. */
export function fuse(lists, key, limit = 8, k = 60) {
  const score = new Map();
  const item = new Map();
  for (const list of lists) {
    list.forEach((x, rank) => {
      const id = key(x);
      score.set(id, (score.get(id) || 0) + 1 / (k + rank + 1));
      if (!item.has(id)) item.set(id, x);
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, s]) => ({ ...item.get(id), fused: s }));
}
