# Gemini Altyazı Çevirmeni (Nuvio / Stremio eklentisi)

Nuvio'da (ve Stremio'da) bir film ya da dizi bölümü açtığında, o içerik için mevcut
İngilizce altyazıyı OpenSubtitles'tan alır, Google Gemini ile Türkçeye (veya seçtiğin
başka bir dile) çevirir ve altyazı listesine "Türkçe" seçeneği olarak ekler.

- Zamanlamalar ve satır numaraları modele hiç gitmez, sadece metin çevrilir; senkron bozulmaz.
- `<i>`, `{\an8}` gibi biçim etiketleri korunur.
- Çeviriler önbelleğe alınır: aynı altyazı ikinci kez çevrilmez, API'yi boşa harcamaz.
- Kendi Gemini API anahtarınla çalışır. Varsayılan model `gemini-3.6-flash` (daha kaliteli çeviri). Daha hızlı ve ücretsiz kotası daha geniş olan `gemini-3.5-flash-lite` ayar sayfasından seçilebilir; sunucuda `GEMINI_MODEL` ortam değişkeniyle varsayılan değiştirilebilir.
- Hiçbir npm paketi gerekmez, Node.js 18 veya üstü yeterli.

## 1. Ücretsiz Gemini API anahtarı al

1. https://aistudio.google.com/apikey adresine Google hesabınla gir.
2. **Create API key** (API anahtarı oluştur) de, bir proje seç ya da yenisini oluştur.
3. `AIza…` ile başlayan anahtarı kopyala. Bunu kimseyle paylaşma.

Gemini API'nin ücretsiz kullanım katmanı var; güncel dakikalık/günlük limitlerini
AI Studio'daki "Rate limits" sayfasında görürsün. Bir film altyazısı yaklaşık
birkaç istek tutar. Eklenti aynı anahtarla dakikada en fazla 12 istek gönderir; limite takılırsa
Gemini'nin söylediği kadar bekleyip devam eder. Günlük kota dolarsa altyazıda bunu yazar.

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

## Doğal çeviri

- Çeviri talimatı, metnin kelime kelime değil Türkçe yazılmış gibi okunması için yazıldı: Türkçe söz dizimi, gereksiz "ben/sen/o" atılır, deyimler Türkçe karşılıklarıyla verilir, karakterlerin konuşma tarzı korunur, satırlar okunabilir uzunlukta tutulur.
- Çeviriden önce bölümün tamamı hızlı bir modelle bir kez okunur ve karakterler, kimin kime "sen" ya da "siz" dediği ve tekrar eden terimler not edilir. Bu notlar her parçaya gönderilir, böylece bölüm boyunca isimler ve hitaplar tutarlı kalır. Not modeli `GEMINI_NOTES_MODEL` ile değişir (`off` kapatır, varsayılan `gemini-3.5-flash-lite`).
- Her parça çevrilirken önceki 8 ve sonraki 4 satır da bağlam olarak gönderilir.
- Flash'ın günlük ücretsiz kotası dolarsa çeviri yarıda kalmaz, kalan satırlar `gemini-3.5-flash-lite` ile tamamlanır (`GEMINI_FALLBACK_MODEL` ile değişir, `off` kapatır).

## OpenRouter yedeği

Gemini'nin günlük ücretsiz kotası (Flash, sonra Flash-Lite) dolunca çeviri OpenRouter'ın ücretsiz modelleriyle devam eder.

- Render'da `OPENROUTER_API_KEY` ortam değişkenine OpenRouter anahtarını gir. Anahtar yoksa yedek kapalıdır.
- Modeller `OPENROUTER_MODEL` ile değişir (virgülle sırayla). Varsayılan: `nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free,openrouter/free`. Sadece `:free` modeller kullanıldığı için ücret çıkmaz.
- Ücretsiz hesapta günde 50 istek var (bir bölüm 3-5 istek). Yedek sadece sunucunun kendi Gemini anahtarıyla (kısa `/tr` linki) çalışır.
- "data policy" hatası alırsan OpenRouter'da Settings > Privacy altında ücretsiz modellere izin ver.

### İlk tercih: GPT-6 Luna (ücretli)

`OPENROUTER_API_KEY` varsa kısa `/tr` linki önce `openai/gpt-6-luna` ile çevirir (girişte milyon token başına 0,10 $, çıkışta 0,50 $; bir bölüm yaklaşık 1 sent). Bunun için OpenRouter hesabında bakiye olmalı. Bakiye biterse veya Luna hata verirse çeviri sırasıyla Gemini Flash, Flash-Lite ve ücretsiz OpenRouter modelleriyle devam eder.

- Başka bir model için `OPENROUTER_PRIMARY_MODEL` gir, kapatmak için `off` yaz.
- Dakikadaki istek sınırı `OPENROUTER_PRIMARY_RPM` (varsayılan 60).

## Senkron: videoya uyan altyazıyı seçme

Bir altyazı eklentisi videonun kendisini görmez; oynatıcı sadece dizinin kimliğini, dosya adını ve (varsa) dosyanın OpenSubtitles parmak izini (videoHash) gönderir. Bu yüzden videonun içine gömülü altyazıyı okuyup çeviremez.

Bunun yerine eklenti, kaynak listesinden bu dosya için yapılmış altyazıyı öne alır: önce parmak izi tutanı, sonra aynı yayın grubu, kaynak (WEB-DL, HDTV, BluRay) ve çözünürlükte olanı. Bilgi yoksa eski dil sırası geçerlidir. Küçük kaymalar için oynatıcının altyazı gecikmesi ayarını kullanabilirsin.

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

Sadece `GEMINI_API_KEY` ekler, `ADDON_PASSWORD` eklemezsen kısa link
(`https://…onrender.com/manifest.json`) varsayılan ayarlarla (Türkçe, Kore modu otomatik)
doğrudan çalışır; AIOStreams gibi uzun linki zor taşıyan yerlerde işe yarar. Bu durumda
kısa linki bilen herkes senin Gemini kotanı kullanabilir.

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
