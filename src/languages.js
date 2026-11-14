'use strict';

// ISO 639-2 codes (the ones Stremio / OpenSubtitles use) -> names.
// `name` goes into the prompt, `label` is shown on the configure page.
const LANGUAGES = {
  tur: { name: 'Turkish', label: 'Türkçe' },
  eng: { name: 'English', label: 'English' },
  aze: { name: 'Azerbaijani', label: 'Azərbaycanca' },
  deu: { name: 'German', label: 'Deutsch' },
  fra: { name: 'French', label: 'Français' },
  spa: { name: 'Spanish', label: 'Español' },
  ita: { name: 'Italian', label: 'Italiano' },
  por: { name: 'Portuguese (Portugal)', label: 'Português' },
  pob: { name: 'Portuguese (Brazil)', label: 'Português (Brasil)' },
  nld: { name: 'Dutch', label: 'Nederlands' },
  pol: { name: 'Polish', label: 'Polski' },
  rus: { name: 'Russian', label: 'Русский' },
  ukr: { name: 'Ukrainian', label: 'Українська' },
  ara: { name: 'Arabic', label: 'العربية' },
  per: { name: 'Persian', label: 'فارسی' },
  ell: { name: 'Greek', label: 'Ελληνικά' },
  ron: { name: 'Romanian', label: 'Română' },
  bul: { name: 'Bulgarian', label: 'Български' },
  hun: { name: 'Hungarian', label: 'Magyar' },
  ces: { name: 'Czech', label: 'Čeština' },
  swe: { name: 'Swedish', label: 'Svenska' },
  jpn: { name: 'Japanese', label: '日本語' },
  kor: { name: 'Korean', label: '한국어' },
  zho: { name: 'Chinese (Simplified)', label: '中文' },
  hin: { name: 'Hindi', label: 'हिन्दी' },
  ind: { name: 'Indonesian', label: 'Bahasa Indonesia' },
};

function languageName(code) {
  return (LANGUAGES[code] && LANGUAGES[code].name) || code;
}

module.exports = { LANGUAGES, languageName };
