/**
 * Map folder names: every variant of one map goes into one folder named after the map.
 *
 *   "Zen Monastery - 03a Autumn Day", "Zen Garden Monastery (Winter Night)",
 *   "Zen Garden Monastery Animated - 01a 4k", "01b Secret Fey Fountain",
 *   "Pirate Tavern Day Rain 2F", "Ground Floor Night"
 *
 * mapGroupName() strips numbering, variant codes and variant words from one name.
 * groupNames() looks at a whole batch and also merges related names
 * ("Secret Fey Fountain Cave" → "Secret Fey Fountain", "Zen Garden Monastery" → "Zen Monastery").
 */

// Words that only describe a variant of a map: time of day, weather, season, lighting,
// resolution, grid, animation. They are dropped anywhere except as the first word.
const VARIANT_WORDS = new Set(`
  day night dawn dusk evening morning noon midnight sunset sunrise twilight
  spring summer autumn fall winter snow snowy rain rainy storm stormy fog foggy mist misty cloudy clear
  light lights lit unlit dark bright lighting nolights
  grid gridded gridless nogrid
  hd fhd uhd qhd 1k 2k 4k 8k 1080p 1440p 2160p hq lq low high res
  animated animation static still loop looped video
  original alt alternate alternative variant var ver version v copy final edit edited
  clean empty furnished unfurnished props noprops
  день ночь утро вечер сетка анимация зима лето осень весна дождь туман
`.trim().split(/\s+/));
// Two-word variants ("no lights", "without grid").
const VARIANT_PAIRS = /\b(?:no|without|with|без|с)\s+(?:lights?|grid|props|tokens|furniture|сетки|света)\b/gi;
// "01", "01a", "03b", "2F", "#4", "v2", "(1)", "[2]", "x2", "30x20".
const CODE = /^(?:#?\d+[a-z]{0,2}|v\d+|x\d+|\d+x\d+|[a-z]\d+)$/i;

const sanitizeSpaces = s => s.replace(/[_]+/g, " ").replace(/\s{2,}/g, " ").trim();

function stemOf(name) {
  const base = String(name ?? "").split("/").pop();
  return base.replace(/\.[a-z0-9]{2,5}$/i, "");
}

function isVariantWord(word) {
  const w = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return !w || VARIANT_WORDS.has(w) || CODE.test(w);
}

/** Drop variant words, keeping the first word unless it is a number code. */
function stripWords(text) {
  const words = text.split(" ").filter(Boolean);
  const kept = words.filter((w, i) => (i === 0 ? !CODE.test(w.replace(/[^\p{L}\p{N}#]/gu, "")) : !isVariantWord(w)));
  return kept.join(" ");
}

/** Base map name for one file or scene name. */
export function mapGroupName(name) {
  const original = sanitizeSpaces(stemOf(name));
  // Numbers glued to the name: "01LiarBar", "1aLiarBar", "LiarBar02", "LiarBar_03b".
  let s = original
    .replace(/^#?\d+[a-z]?(?=[A-Z])/, "")
    .replace(/^#?\d+(?=[a-zа-я]{3})/i, m => `${m} `)
    .replace(/([a-zа-я])(\d+[a-z]?)$/i, "$1 $2");
  // Leading "[Author]" and numbering: "01b Secret Fey Fountain", "[Czepeku] Forest".
  s = s.replace(/^\s*[[(][^\])]{1,40}[\])]\s*/, "");
  // Bracketed parts are variants: "(Winter Night)", "[4k]".
  s = s.replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, " ");
  s = s.replace(VARIANT_PAIRS, " ");
  // "Name - variant": keep the name when the part after the dash is a code or variant words.
  const parts = s.split(/\s+[-–—|]\s+|\s*[–—|]\s*/).map(p => sanitizeSpaces(p)).filter(Boolean);
  if (parts.length > 1) {
    const head = stripWords(parts[0]);
    const tail = parts.slice(1).join(" ");
    const tailWords = tail.split(" ");
    // "Zen Monastery - 03a Autumn Day" or "Temple of Couatl - Sunset": the tail is a variant.
    if (head && (CODE.test(tailWords[0]) || tailWords.every(isVariantWord))) s = head;
    else s = parts.join(" ");
  }
  s = sanitizeSpaces(s.replace(/[-–—,.]+/g, " "));
  s = stripWords(s);
  s = s.replace(/^\s*(?:#?\d+[a-z]{0,2})\s+/i, "").trim(); // numbering left after stripping
  // A folder name never starts or ends with a number code.
  s = s.replace(/^(?:#?\d+[a-z]?\s+)+/i, "").replace(/(?:\s+#?\d+[a-z]?)+$/i, "").trim();
  return s || original.replace(/^[\d\s#._-]+/, "") || original;
}

const words = s => s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/\s+/).filter(Boolean);
const flat = s => words(s).join("");

/** True when every word of `short` appears in `long`, in order, starting with the same word. */
function contains(short, long) {
  const a = words(short);
  const b = words(long);
  if (a.length < 2 && a[0]?.length < 5) return false; // "The", "Inn" are too vague to merge on
  if (a.length >= b.length || a[0] !== b[0]) return false;
  let i = 0;
  for (const w of b) if (w === a[i]) i++;
  return i === a.length;
}

/**
 * Folder names for a batch of map names. Related names are merged into the shortest one:
 * "Secret Fey Fountain Cave" joins "Secret Fey Fountain", "Zen Garden Monastery" joins "Zen Monastery".
 * @param {string[]} names     File or scene names in the batch
 * @param {string[]} existing  Map folders already on Drive under the same author
 * @returns {Map<string, string>} name → folder
 */
export function groupNames(names, existing = []) {
  const base = new Map(names.map(n => [n, mapGroupName(n)]));
  const pool = [...new Set([...existing.map(e => mapGroupName(e) === e ? e : null).filter(Boolean), ...base.values()])]
    .sort((a, b) => words(a).length - words(b).length || a.length - b.length);
  const canonical = new Map();
  const roots = [];
  for (const g of pool) {
    const root = roots.find(r => flat(r) === flat(g) || contains(r, g));
    if (root) canonical.set(g, root);
    else {
      roots.push(g);
      canonical.set(g, g);
    }
  }
  return new Map([...base].map(([n, g]) => [n, canonical.get(g) ?? g]));
}
