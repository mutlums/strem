# Gemini Altyazı Çevirmeni (Nuvio / Stremio eklentisi)

Nuvio'da (ve Stremio'da) bir film ya da dizi bölümü açtığında, o içerik için mevcut
İngilizce altyazıyı OpenSubtitles'tan alır, Google Gemini ile Türkçeye (veya seçtiğin
başka bir dile) çevirir ve altyazı listesine "Türkçe" seçeneği olarak ekler.

- Zamanlamalar ve satır numaraları modele hiç gitmez, sadece metin çevrilir; senkron bozulmaz.
- `<i>`, `{\an8}` gibi biçim etiketleri korunur.
- Çeviriler önbelleğe alınır: aynı altyazı ikinci kez çevrilmez, API'yi boşa harcamaz.
- Kendi Gemini API anahtarınla çalışır. Varsayılan model `gemini-3.5-flash-lite` (ucuz ve hızlı).
- Hiçbir npm paketi gerekmez, Node.js 18 veya üstü yeterli.

## 1. Ücretsiz Gemini API anahtarı al

1. https://aistudio.google.com/apikey adresine Google hesabınla gir.
2. **Create API key** (API anahtarı oluştur) de, bir proje seç ya da yenisini oluştur.
3. `AIza…` ile başlayan anahtarı kopyala. Bunu kimseyle paylaşma.

Gemini API'nin ücretsiz kullanım katmanı var; güncel dakikalık/günlük limitlerini
AI Studio'daki "Rate limits" sayfasında görürsün. Bir film altyazısı yaklaşık
10–20 istek tutar. Limite takılırsan eklenti bekleyip yeniden dener.

## 2. Eklentiyi ücretsiz yayınla (Render örneği)

Eklentinin internette, Nuvio'nun ulaşabileceği bir adreste çalışması gerekiyor.
Render'ın ücretsiz planı bunun için yeterli (kredi kartı istemiyor).

1. GitHub'da ücretsiz bir hesap aç, **New repository** ile yeni (tercihen private) bir depo oluştur.
2. Bu klasördeki dosyaları (zip'in içindekileri) depoya yükle: **Add file → Upload files**.
3. https://render.com adresinde GitHub hesabınla giriş yap.
4. **New → Web Service** de, depoyu seç.
5. Ayarlar: Runtime **Node**, Build Command `npm install`, Start Command `npm start`, Instance Type **Free**.
6. **Create Web Service** de. Birkaç dakika sonra `https://<isim>.onrender.com` gibi bir adres verir.

Not: Render'ın ücretsiz sunucusu 15 dakika kullanılmayınca uyur, ilk istekte uyanması
yaklaşık bir dakika sürer. İlk açılışta altyazı listesi gelmezse videoyu kapatıp tekrar aç.
Uyurken önbellek de silinebilir.

Docker destekleyen başka bir ücretsiz servis kullanmak istersen hazır `Dockerfile` var.

## 3. Ayar sayfasından eklenti linkini oluştur

1. Tarayıcıda `https://<isim>.onrender.com/configure` adresini aç.
2. Gemini API anahtarını yapıştır, dil olarak **Türkçe**yi seç.
3. **Anahtarı dene** ile çalıştığını kontrol et (örnek bir cümleyi çevirir).
4. **Eklenti linkini oluştur** de ve **Linki kopyala**.

Anahtarın bu linkin içinde durur, linki kimseyle paylaşma.

## 4. Nuvio'ya ekle

1. Nuvio'da **Ayarlar → Eklentiler (Addons)** bölümüne gir.
2. **Eklenti ekle (Add Addon)** de, kopyaladığın linki **Addon URL** alanına yapıştır.
3. **Eklentiyi kur (Install Addon)** de.

Bir film aç, altyazı menüsünde "Türkçe" (tur) seçeneklerini göreceksin. Birini seçince
çeviri başlar. Bir film için genelde 15–60 saniye sürer; listede ilk seçenek arka planda
önceden çevrilmeye başladığı için çoğu zaman daha hızlı hazır olur. Aynı altyazı
ikinci kez anında gelir.

Çeviri çok uzun sürerse (varsayılan 100 sn) o ana kadar çevrilen kısım Türkçe, kalanı
orijinal haliyle gelir; birkaç dakika sonra altyazıyı yeniden seçince tamamı gelir.

## Kore filmleri ve dizileri için kültür modu

Ayar sayfasındaki **Kore yapımları için kültür modu** varsayılan olarak **Otomatik**: içerik Güney Kore
yapımıysa (bilgi Stremio/Nuvio'nun kullandığı Cinemeta'dan alınır) çeviri şöyle değişir:

- Varsa önce **Korece** altyazıdan çevirir; İngilizce altyazılarda hitaplar genelde kaybolur.
- **Hitaplar** (Oppa, Hyung, Unnie, Noona, Sunbae, Ajumma, Seonsaengnim, -ssi, -nim) olduğu gibi kalır.
  İstersen "Türkçeleştir" seçeneğiyle abi, abla, hocam, Bey/Hanım şeklinde çevrilir.
- **Sen/siz** ayrımı Korecedeki konuşma düzeyine göre yapılır (büyüklere, üstlere, yabancılara "siz").
- Soju, kimchi, ramyeon, hanbok, chaebol gibi kelimeler Türkçe karşılıklarla değiştirilmez.
- Kore isimleri kaynaktaki gibi (soyadı önce) kalır.

## Sorun giderme

- **Altyazı listesinde hiç Türkçe seçenek yok:** O içerik için OpenSubtitles'ta İngilizce altyazı
  olmayabilir. Ayar sayfasında "Kaynak altyazı dili"ne başka dil ekleyebilirsin (örn. `eng,spa`).
- **Altyazıda "Gemini Altyazı Çevirmeni: …" diye bir hata yazıyor:** Mesajda sebebi yazar.
  Genelde anahtar yanlış, model adı hatalı ya da günlük limit dolmuştur.
- **Model adı değişti:** Google modelleri zamanla yeniler. Ayar sayfasında "Başka bir model adı
  yaz…" ile yeni adı girip linki yeniden oluştur ve eklentiyi Nuvio'da yeniden kur.

## Gelişmiş: anahtarı sunucuda tutmak

Anahtarın linkte durmasını istemezsen Render'da **Environment** bölümüne
`GEMINI_API_KEY` ve `ADDON_PASSWORD` ekle. Ayar sayfasında anahtar alanını boş bırak,
şifreyi gir. Diğer ayarlar için `.env.example` dosyasına bak.

## Geliştirici notları

```
npm start        # http://localhost:7000/configure
npm test         # SRT ayrıştırma, çeviri ve uçtan uca testler (Gemini taklit edilir)
```

Yollar (Stremio eklenti protokolü):

- `/manifest.json`, `/<config>/manifest.json`
- `/<config>/subtitles/<movie|series>/<imdb id>[/<extra>].json`
- `/<config>/translate/<kaynak url base64url>.srt` – çevrilmiş SRT
- `/configure`, `/health`, `POST /api/test`

`<config>`, ayar sayfasının ürettiği base64url JSON'dur: `{ key, lang, model, src, max }`.
