'use strict';

// Extra translation instructions for specific kinds of content.
// Currently: South Korean films and series (K-drama).

const KOREAN_KEEP_HONORIFICS = [
  '- Address terms and honorifics: keep Korean terms in their usual romanized form, the way Turkish K-drama fansubs do:',
  '  Oppa, Hyung, Unnie, Noona, Sunbae, Hoobae, Ajumma, Ajusshi, Halmeoni, Harabeoji, Eomma, Appa, Eomeoni, Abeoji,',
  '  Seonsaengnim, Sajangnim, Hoejangnim, Daepyonim, Timjangnim, Bujangnim, Gwajangnim, Daeri-nim, Gyeongwi-nim,',
  '  and name suffixes like -ssi, -nim, -ah/-ya (e.g. "Ji-woo-ssi", "Min-ho-ya"). Never turn them into "kardeşim", "abi/abla" or "efendim".',
  '- If the source is an English translation, it has often flattened these terms ("brother", "sis", "sir", "boss", "teacher", "Mr. Kim",',
  '  "Chairman", "Team Leader"). When context clearly shows which Korean term was meant (who speaks to whom, age, rank), restore it',
  '  (e.g. a younger woman to an older man saying "brother" -> "Oppa"; "Mr. Kim" said by a subordinate -> "Kim Bujangnim" only if the rank is clear,',
  '  otherwise "Kim-ssi"). If unsure, translate the English naturally instead of guessing.',
];

const KOREAN_TURKISH_HONORIFICS = [
  '- Address terms and honorifics: render them with natural Turkish equivalents, consistently:',
  '  Oppa/Hyung -> abi, Unnie/Noona -> abla, Sunbae -> abi/abla (or "kıdemli" in work/school settings), Hoobae -> by name,',
  '  Ajumma -> teyze, Ajusshi -> amca, Halmeoni -> nine/babaanne/anneanne, Harabeoji -> dede, Eomma/Appa -> anne/baba,',
  '  Seonsaengnim -> hocam/öğretmenim/doktor (by context), Sajangnim/Hoejangnim/Daepyonim -> Başkan/Patron, Timjangnim -> şefim/müdürüm,',
  '  -ssi -> Bey/Hanım after the name (Ji-woo Hanım), -nim -> "efendim" or the title. Restore such terms from English',
  '  ("brother", "sir", "boss") when the relationship is clear.',
];

function koreanInstructions({ honorifics = 'keep' } = {}) {
  return [
    'This subtitle is from a South Korean film or series. Translate with Korean cultural awareness:',
    ...(honorifics === 'tr' ? KOREAN_TURKISH_HONORIFICS : KOREAN_KEEP_HONORIFICS),
    '- Speech levels: mirror Korean politeness in the target language. For Turkish: use "siz" (and polite verb forms) toward elders,',
    '  superiors, strangers, in-laws and in formal/work settings (jondaetmal); use "sen" between close friends, couples, family members',
    '  speaking to younger ones, and when someone is being rude or intimate on purpose (banmal). A switch from siz to sen (or back) is',
    '  often meaningful in the story: keep it.',
    '- Names: keep Korean names exactly as romanized in the source, family name first (Kim Ji-woo), with the hyphen.',
    '- Keep culture-specific words Turkish K-drama viewers know, untranslated: soju, makgeolli, kimchi, ramyeon, tteokbokki, kimbap,',
    '  samgyeopsal, banchan, hanbok, hanok, chaebol, aegyo, noraebang, PC bang, jjimjilbang, Chuseok, Seollal.',
    '  Do not replace them with Turkish foods, drinks or customs.',
    '- Interjections: render naturally (Aigoo -> "Off ya" / "Of of", Omo/Eomeona -> "Aman!", Daebak -> "İnanılmaz!", Jinjja? -> "Gerçekten mi?",',
    '  Aish -> "Hay aksi" / "Lanet olsun"), but keep "Hwaiting!" as "Fighting!" when it is a cheer.',
    '- Ages and ranks matter: keep the same address term for the same pair of characters throughout.',
  ].join('\n');
}

function styleInstructions(style, opts) {
  if (style === 'kr') return koreanInstructions(opts);
  return '';
}

module.exports = { styleInstructions, koreanInstructions };
