'use strict';

const { LANGUAGES } = require('./languages');

const MODELS = [
  ['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite (önerilen, ucuz ve hızlı)'],
  ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite (daha eski flash-lite)'],
  ['gemini-3.6-flash', 'gemini-3.6-flash (daha kaliteli, daha pahalı)'],
];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function configurePage({ cfg, serverKey, needsPassword, defaultModel }) {
  const cur = cfg || { lang: 'tur', model: defaultModel, src: ['eng'], max: 2 };
  const langOptions = Object.entries(LANGUAGES)
    .map(([code, l]) => `<option value="${code}"${code === cur.lang ? ' selected' : ''}>${esc(l.label)} (${code})</option>`)
    .join('');
  const known = MODELS.some(([m]) => m === cur.model);
  const modelOptions =
    MODELS.map(([m, label]) => `<option value="${m}"${m === cur.model ? ' selected' : ''}>${esc(label)}</option>`).join('') +
    `<option value="__custom"${known ? '' : ' selected'}>Başka bir model adı yaz…</option>`;

  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gemini Altyazı Çevirmeni</title>
<style>
  :root { --bg:#0f1115; --card:#181b22; --text:#e8eaf0; --muted:#9aa1b2; --accent:#7aa2ff; --ok:#4cc38a; --err:#ff6b6b; --border:#2a2f3a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  main { max-width:560px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:26px; margin:8px 0 4px; }
  p.lead { color:var(--muted); margin:0 0 20px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:18px; margin-bottom:16px; }
  label { display:block; font-weight:600; margin:14px 0 6px; }
  label:first-child { margin-top:0; }
  small { color:var(--muted); display:block; margin-top:4px; }
  input, select { width:100%; padding:11px 12px; border-radius:10px; border:1px solid var(--border); background:#0d0f13; color:var(--text); font-size:16px; }
  button { width:100%; padding:13px; border:0; border-radius:10px; font-size:16px; font-weight:600; cursor:pointer; margin-top:10px; }
  .primary { background:var(--accent); color:#0b1020; }
  .secondary { background:#252a35; color:var(--text); }
  #out { display:none; }
  #url { font-family:ui-monospace, Menlo, monospace; font-size:13px; word-break:break-all; background:#0d0f13; padding:10px; border-radius:8px; border:1px solid var(--border); }
  .msg { margin-top:10px; font-size:14px; }
  .ok { color:var(--ok); } .err { color:var(--err); }
  a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Gemini Altyazı Çevirmeni</h1>
  <p class="lead">Nuvio ve Stremio için: izlediğin içeriğin mevcut altyazısını Google Gemini ile seçtiğin dile çevirir.</p>

  <div class="card">
    <label for="key">Gemini API anahtarı</label>
    <input id="key" type="password" autocomplete="off" placeholder="${serverKey ? 'Boş bırakırsan sunucudaki anahtar kullanılır' : 'AIza…'}">
    <small>Ücretsiz anahtarı <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>'dan alabilirsin. Anahtar sadece eklenti linkinin içinde durur, bu linki kimseyle paylaşma.</small>
    ${needsPassword ? `<label for="pass">Sunucu şifresi</label><input id="pass" type="password" autocomplete="off"><small>Sunucudaki anahtarı kullanmak için ADDON_PASSWORD değeri.</small>` : ''}

    <label for="lang">Çeviri dili</label>
    <select id="lang">${langOptions}</select>

    <label for="model">Gemini modeli</label>
    <select id="model">${modelOptions}</select>
    <input id="modelCustom" style="display:${known ? 'none' : 'block'};margin-top:8px" placeholder="örn. gemini-3.5-flash-lite" value="${known ? '' : esc(cur.model)}">

    <label for="src">Kaynak altyazı dili</label>
    <input id="src" value="${esc(cur.src.join(','))}">
    <small>Hangi dildeki altyazı çevrilsin. Virgülle sıra verebilirsin, örn. <code>eng,spa</code>.</small>

    <label for="max">Listede kaç seçenek olsun</label>
    <select id="max">${[1, 2, 3].map((n) => `<option${n === cur.max ? ' selected' : ''}>${n}</option>`).join('')}</select>
    <small>Her seçenek farklı bir kaynak altyazının çevirisi. Yalnızca seçtiğin çevrilir (ilki arka planda hazırlanmaya başlar).</small>

    <button class="secondary" id="test">Anahtarı dene</button>
    <div class="msg" id="testMsg"></div>
    <button class="primary" id="make">Eklenti linkini oluştur</button>
  </div>

  <div class="card" id="out">
    <label>Eklenti linki (manifest)</label>
    <div id="url"></div>
    <button class="primary" id="copy">Linki kopyala</button>
    <button class="secondary" id="stremio">Stremio'da aç</button>
    <small>Nuvio: Ayarlar → Eklentiler → Eklenti ekle → linki yapıştır → Kur.</small>
  </div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  $('model').addEventListener('change', () => { $('modelCustom').style.display = $('model').value === '__custom' ? 'block' : 'none'; });
  function readCfg() {
    const model = $('model').value === '__custom' ? $('modelCustom').value.trim() : $('model').value;
    const cfg = { key: $('key').value.trim(), lang: $('lang').value, model, src: $('src').value.trim() || 'eng', max: Number($('max').value) };
    if ($('pass')) cfg.pass = $('pass').value;
    return cfg;
  }
  function b64url(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = ''; bytes.forEach((b) => bin += String.fromCharCode(b));
    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  $('test').addEventListener('click', async () => {
    const m = $('testMsg'); m.className = 'msg'; m.textContent = 'Deneniyor…';
    try {
      const r = await fetch('/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(readCfg()) });
      const j = await r.json();
      if (j.ok) { m.className = 'msg ok'; m.textContent = 'Çalışıyor. Örnek çeviri: ' + j.sample; }
      else { m.className = 'msg err'; m.textContent = 'Hata: ' + j.error; }
    } catch (e) { m.className = 'msg err'; m.textContent = 'Hata: ' + e.message; }
  });
  $('make').addEventListener('click', () => {
    const cfg = readCfg();
    if (!cfg.key && !${serverKey ? 'true' : 'false'}) { $('testMsg').className = 'msg err'; $('testMsg').textContent = 'Önce Gemini API anahtarını gir.'; return; }
    const url = location.origin + '/' + b64url(JSON.stringify(cfg)) + '/manifest.json';
    $('url').textContent = url; $('out').style.display = 'block';
    $('stremio').onclick = () => { location.href = url.replace(/^https?:/, 'stremio:'); };
    $('out').scrollIntoView({ behavior: 'smooth' });
  });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('url').textContent); $('copy').textContent = 'Kopyalandı'; }
    catch (_) { const r = document.createRange(); r.selectNodeContents($('url')); getSelection().removeAllRanges(); getSelection().addRange(r); }
  });
</script>
</body>
</html>`;
}

module.exports = { configurePage };
