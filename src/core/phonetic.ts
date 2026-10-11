/**
 * A sound-alike key for spoken names (a simplified Metaphone): "cloud" and "Claude" both become KLT, so a
 * misheard app name can still be matched. Used only to match a name slot against a known list (installed
 * apps, aliases), never on free text, so "search for cloud storage" is never rewritten.
 */

const VOWELS = new Set(["a", "e", "i", "o", "u"]);

/** `first`: only a phrase's first word keeps its opening vowel ("spot if i" sounds like "spotify"). */
function wordKey(word: string, first = true): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return "";
  // Silent or merged openings.
  w = w.replace(/^(?:kn|gn|pn|wr|ps)/, (m) => m[1]!).replace(/^x/, "s").replace(/^wh/, "w");
  let out = "";
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!;
    const next = w[i + 1] ?? "";
    const prev = w[i - 1] ?? "";
    if (c === prev && c !== "c") continue;
    if (VOWELS.has(c)) {
      if (i === 0 && first) out += "A";
      continue;
    }
    switch (c) {
      case "b":
        if (!(prev === "m" && i === w.length - 1)) out += "P";
        break;
      case "c":
        if (next === "h") { out += w[i + 2] === "r" || prev === "s" ? "K" : "X"; i++; }
        else if ("iey".includes(next)) out += "S";
        else if (prev !== "s" || next !== "k") out += "K";
        break;
      case "d":
        out += next === "g" && "iey".includes(w[i + 2] ?? "") ? "J" : "T";
        break;
      case "g":
        if (next === "h" && !VOWELS.has(w[i + 2] ?? "")) break;
        if (next === "n" && i + 2 >= w.length) break;
        out += "iey".includes(next) ? "J" : "K";
        break;
      case "h":
        if (VOWELS.has(next) && !"cgpst".includes(prev)) out += "H";
        break;
      case "k":
        if (prev !== "c") out += "K";
        break;
      case "p":
        if (next === "h") { out += "F"; i++; } else out += "P";
        break;
      case "q":
        out += "K";
        break;
      case "s":
        if (next === "h") { out += "X"; i++; } else out += "S";
        break;
      case "t":
        if (next === "h") { out += "0"; i++; } else out += "T";
        break;
      case "v":
        out += "F";
        break;
      case "w":
      case "y":
        if (VOWELS.has(next) && !VOWELS.has(prev)) out += c.toUpperCase();
        break;
      case "x":
        out += "KS";
        break;
      case "z":
        out += "S";
        break;
      default:
        out += c.toUpperCase();
    }
  }
  return out;
}

/** The sound-alike key of a phrase, word keys run together ("cloud" → "KLT", "google chrome" → "KKLKRM"). */
export function phoneticKey(phrase: string): string {
  return phrase.split(/\s+/).map((w, i) => wordKey(w, i === 0)).join("");
}
