// Arama: kelime araması, vektör benzerliği ve harmanlama
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokens, buildIndex, bm25, cosineTop, fuse, fold } from '../src/search.js';

test('kelimeler: Türkçe ekler ve büyük/küçük harf eşleşmeyi bozmaz; kod ve sayılar olduğu gibi kalır', () => {
  assert.equal(fold('İADE Işık'), 'iade işik');
  assert.deepEqual(tokens('Siparişlerin iptali ve siparişi'), ['sipari', 'iptali', 'sipari']);
  assert.deepEqual(tokens('HATA-4021 kodu, madde 12.3'), ['hata-4021', 'kodu', 'madde', '12.3']);
  assert.deepEqual(tokens('bu ve şu'), [], 'bağlaçlar atılır');
});

test('BM25: sorgu kelimelerini en çok ve en özgün içeren parça üstte çıkar', () => {
  const chunks = [
    { text: 'Sipariş iptali müşteri başvurusuyla yapılır. İptal edilen siparişin ücreti iade edilir.' },
    { text: 'Kargo süresi üç iş günüdür. Kargo ücreti alıcıya aittir.' },
    { text: 'İade süresi 14 gündür. İade başvurusu sipariş numarasıyla yapılır.' },
  ];
  const index = buildIndex(chunks);
  assert.equal(bm25(index, 'iade süresi kaç gün')[0].i, 2);
  assert.equal(bm25(index, 'SİPARİŞLERİ iptal etmek')[0].i, 0);
  assert.equal(bm25(index, 'kargo ücreti')[0].i, 1);
  assert.deepEqual(bm25(index, 'bulunmayan kelime'), []);
});

test('vektör benzerliği en yakın parçayı bulur; harmanlama iki aramada da üstte olanı öne alır', () => {
  const vectors = Float32Array.from([1, 0, 0, 0, 1, 0, 0.9, 0.1, 0]);
  const top = cosineTop(vectors, 3, Float32Array.from([1, 0, 0]), 2);
  assert.deepEqual(top.map((t) => t.i), [0, 2]);
  const fused = fuse([[{ id: 'a' }, { id: 'b' }, { id: 'c' }], [{ id: 'b' }, { id: 'd' }]], (x) => x.id, 3);
  assert.deepEqual(fused.map((x) => x.id), ['b', 'a', 'd']);
});
