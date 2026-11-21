# Fikirhane

Büyük belgeleri **bu bilgisayardaki yerel dil modeliyle** okuyup anlamlandıran, onaylı bilgi notlarına çeviren ve
soruları kaynak göstererek yanıtlayan yerel bir uygulama. Node.js ile çalışır; belgeleriniz bu bilgisayardan dışarı çıkmaz
(yalnızca Ayarlar'da yazdığınız model sunucusuna gider).

Klasik "her soruda parça ara" yaklaşımından farkı: belge bir kez okunur, bölüm bölüm nota ve bir sayfalık haritaya
çevrilir, model size sorular sorar, siz yanıtlar ve düzeltirsiniz. Sorular bu onaylı bilgiye, sizin notlarınıza ve en
ilgili asıl bölümlere dayanarak yanıtlanır.

## Nasıl çalışır

1. **Yükle** — PDF, Word (.docx), metin, Markdown, HTML ya da CSV. Metin sayfa sayfa çıkarılır, parçalanır ve hemen
   aranabilir olur. Bu adım yapay zekâ kullanmaz.
2. **Anlamlandır** — yerel model belgeyi bölüm bölüm okur: her bölüm için not (öz, kurallar, terimler; sayfa
   numaralarıyla), sonra belgenin bir sayfalık haritası, sonra size soracağı en fazla 6 soru. İş arka planda sürer,
   durdurulabilir ve kaldığı yerden devam eder.
3. **Besle ve onayla** — soruları yanıtlar, haritayı düzeltir, kendi notlarınızı eklersiniz. Notlarınız belgeden ayrı
   tutulur; belgeyle çelişirse sizin notunuz esas alınır. Hazır olunca belgeyi onaylarsınız.
4. **Sor** — soru tek belgeye ya da bütün belgelere sorulur. Yanıtta her bilginin yanında `[belge s.N]` kaynağı yazar;
   kaynak bölümlere tıklayınca asıl sayfa açılır. **Yalnızca ara** yapay zekâ kullanmadan belgede geçen yerleri bulur.

Arama iki katmanlıdır: kelime araması (BM25; Türkçe eklere dayanıklı) her zaman çalışır. Ayarlar'da bir embedding modeli
seçilirse "Anlamsal dizin oluştur" ile anlamsal arama da eklenir ve iki sonuç harmanlanır.

## Site gezme

Belgelerin yanında bir **web uygulaması** da tanıtılabilir. Sol üstteki **Site gez** ayrı bir tarayıcı penceresi açar
(bu bilgisayardaki Microsoft Edge ya da Google Chrome; ek kurulum gerekmez). Orada giriş yapıp ekranları gezersiniz;
her ekranın yapısı bir **ekran kartı** olarak kaydedilir: adres, başlıklar, alanlar (türü, zorunlu mu), düğmeler,
bağlantılar, tablo sütunları ve o ekrana hangi tıklamayla gelindiği. "Bağlantıları otomatik gez" kaydedilen ekranlardaki
bağlantıları izleyerek kalan ekranları da toplar. "Bitir ve kaydet" ile site bir belge olur: aranır, yerel modelle
anlamlandırılır (ekranlar, temel akışlar), sorularla beslenir, onaylanır.

Amaç, bir uygulamayı bir kez öğrenip sonra her seferinde yeniden keşfetmemektir: "üye nereden eklenir, hangi alanlar
zorunlu" sorusu ekran kartlarından yanıtlanır; kartlardaki seçiciler (`getByLabel('Fiyat')`,
`getByRole('button', { name: 'Kaydet' })` gibi, Playwright biçiminde) tarayıcı testlerinde doğrudan kullanılabilir.

Tarayıcı testi yapan bir araç (ör. Atölye'deki yapay zekâ oturumu) ekranı her seferinde keşfetmek yerine Fikirhane'ye
sorar. Uçlar salt okunurdur, yerel modeli kullanmaz ve her yanıtta yapılı verinin yanında modele doğrudan verilebilecek
kısa bir `text` bulunur:

| Uç | Ne verir |
|---|---|
| `GET /api/sites` | Gezilmiş siteler |
| `GET /api/sites/<kimlik>` | Harita, kullanıcının notları ve ekran listesi |
| `GET /api/sites/find?q=…&site=<kimlik>` | Sorguyla eşleşen ekranlar ve o ekranlardaki eşleşen alan/düğme seçicileri |
| `GET /api/sites/<kimlik>/screens/<no>` | Tek ekran: bütün alanlar, düğmeler, bağlantılar ve seçicileri |
| `GET /api/sites/<kimlik>/route/<no>` | O ekrana gidiş: doğrudan adres ve kaydedilen tıklama zinciri (`page.goto(…)`, `page.getByRole(…).click()`) |

Sorguyla yönlenen eski tip uygulamalarda (`index.php?action=liste`) `action`, `page`, `view`, `tab`, `sayfa`, `islem`
gibi anahtarların kelime değerleri ekranı belirler; kimlikler `{id}` olur; diğer sorgu değerleri (arama metni vb.) atılır.

Güvenli sınırlar:

- Fikirhane **hiçbir düğmeye basmaz, hiçbir formu göndermez**. Otomatik gezinti yalnızca aynı sitedeki bağlantıların
  adresine gider; çıkış, silme, onay, indirme gibi görünen bağlantıları ve dosyaları atlar. Yine de adresine gidilince
  bir şeyi değiştiren bağlantıları olan uygulamalarda otomatik gezintiyi kullanmayın; elle gezin.
- Alanlara yazdıklarınız, parolalar, sorgu değerleri ve tablo satırlarındaki veriler **kaydedilmez**; kartta yalnızca
  yapı (etiketler, adlar) durur. Aynı kalıptaki adresler (`/urun/12`, `/urun/57`) tek ekran sayılır.
- Tarayıcı geçici bir profille açılır; gezinti bitince profil (çerezler, oturum) silinir. Başka sitedeki sayfalar
  (ör. ortak giriş sayfası) kaydedilmez.

## Yerel dil modeli

OpenAI uyumlu uç noktası olan herhangi bir yerel sunucu kullanılır: **Ollama** (`http://localhost:11434`),
**LM Studio** (`http://localhost:1234`), llama.cpp vb. Ayarlar'da (sol üstteki dişli) sunucu adresi, sohbet modeli ve
isteğe bağlı embedding modeli (ör. `bge-m3`) girilir; "Bağlantıyı dene" sunucudaki modelleri listeler.

Kurum içi bir gateway de kullanılabilir: adres tam uç nokta olarak (`https://gateway.example.com/api/v2/chat/completions`)
ya da kök olarak yazılabilir; `/v1` dışındaki sürüm yolu korunur, API anahtarı `Authorization`, `api-key` ve `x-api-key`
başlıklarında gönderilir.

**Dışa / içe aktarma:** Ayarlar'daki "Dışa aktar" yerel model ayarını `fikirhane-yerel-llm.json` dosyasına yazar; API
anahtarı dosyada açık durmaz, yazdığınız şifreleme anahtarıyla (AES-256-GCM) şifrelenir ve "İçe aktar" aynı anahtarı
sorar. Yanlış anahtarla hiçbir şey değişmez. Dosya biçimi Atölye'ninkiyle ortaktır: Atölye'den dışa aktarılan yerel model
dosyası Fikirhane'de, Fikirhane'ninki Atölye'de içe aktarılabilir. Fikirhane tek model kullandığı için dosyada birden çok
model varsa hangisinin alınacağı sorulur. Şifreleme anahtarını değiştirmezseniz herkesçe bilinen varsayılan (`fikirhane`)
kullanılır; bu gizlilik sağlamaz, yalnızca dosyada açık anahtar durmasını önler.

Model tanımlı değilken de belge yüklenir ve içinde arama yapılır; anlamlandırma ve soru yanıtlama model ister.

## Kurulum

Dağıtım paketi (`npm run paket -- --tam`) zip'i çıkarıp **`Kur.bat`**'a çift tıklayarak kurulur: kurulum sihirbazı açılır
(İleri > İleri > Kur). Fikirhane `%LOCALAPPDATA%\Fikirhane` klasörüne kurulur; masaüstü uygulaması olarak (kendi
penceresi, görev çubuğuna sabitlenebilir) ya da tarayıcıda açılması, masaüstü kısayolu ve Windows açılışında başlatma
sihirbazda seçilir. Depoda daha yeni sürüm varsa kurulum sırasında güncellenir; yapılamazsa paketteki sürüm kurulur.
Tam paket Node.js'i ve kütüphaneleri içinde getirir.

Geliştirme için:

```
npm install
npm start          # http://127.0.0.1:3310
npm test
```

| Komut | Ne yapar |
|---|---|
| `fikirhane.ps1 kur` | Kurulum (konsoldan) |
| `fikirhane.ps1 baslat` / `durdur` / `durum` | Başlat, durdur, durumu göster |
| `fikirhane.ps1 guncelle` | Son sürümü indir ve yeniden başlat |
| `fikirhane.ps1 masaustu-ac` / `masaustu-kapat` | Masaüstü uygulamasını aç/kapat |
| `fikirhane.ps1 kaldir` | Kaldır; belgeler ve notlar (`~/.fikirhane`) yalnızca `-Veriler` ile silinir |

Fikirhane açılışta ve her sabah 9'da güncelleme denetler; yeni sürüm varsa sol altta bağlantı çıkar.

## Veriler

Her şey `~/.fikirhane` altında düz dosyalar olarak durur; elle okunup düzeltilebilir:

```
~/.fikirhane/ayarlar.json                 yerel model sunucusu
~/.fikirhane/belgeler/<kimlik>/meta.json   ad, sayfa sayısı, durum
                               asil.<uzantı>, sayfalar.json, parcalar.json, vektorler.bin
                               notlar.json, harita.md, sorular.json, yorumlar.json
                               ekranlar.json (yalnızca gezilen sitelerde: ekran kartları ve seçiciler)
```

## Güvenlik

Sunucu yalnızca `127.0.0.1` üzerinde dinler. Başka bir alan adıyla gelen istekler ve özel başlık taşımayan değiştirme
istekleri reddedilir; böylece açık bir web sayfası belgelerinize erişemez. API anahtarı (varsa) `ayarlar.json` içinde
düz metin durur ve arayüze geri gönderilmez.

## Sınırlar

- Taranmış (resim) PDF'lerden metin çıkmaz; metin içeren bir sürüm gerekir. Tablolar ve şekiller zayıf kalır.
- Anlamlandırma süresi yerel modelin hızına bağlıdır: 200 sayfalık bir belge onlarca model çağrısı demektir.
- Notlar ve yanıtlar modelin çıkarımıdır; hatalı olabilir. Önemli kararlarda kaynak sayfayı açın.
- Site gezmede iç çerçeveler (iframe) ve kapalı gölge ağaçları okunmaz; erişilebilir adı olmayan düğmeler yalnızca
  sayılır. Arayüz değişince kartlar eskir: site yeniden gezilmelidir (eski kayıt güncellenmez, yeni belge oluşur).
- Atölye ile bağlantı henüz yoktur; önce Fikirhane kendi başına olgunlaştırılıyor.

optona.tr tarafından yazılmıştır. MIT lisansı.
