/**
 * Example sentences with slots, matched by code before any model is asked ("templates first").
 *
 *   play [the] (song|track) {query}
 *
 *   word       that word
 *   (a|b c)    one of these
 *   [a|b c]    optionally one of these
 *   {name}     a slot: one or more of the user's words, as few as fit
 *   *          any words, or none
 *
 * A template matches the whole (normalised) sentence. Slots are spans of the user's own words, never generated.
 */

export interface Template {
  source: string;
  re: RegExp;
  slots: string[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function alternatives(body: string): string {
  return body
    .split("|")
    .map((alt) => alt.trim().split(/\s+/).map(esc).join(" "))
    .join("|");
}

/** A template's tokens: "(a|b)", "[a|b]", "{slot}", "*" and plain words. */
export function templateTokens(source: string): string[] {
  return source.match(/\([^)]*\)|\[[^\]]*\]|\{\w+\}|\*|[^\s()[\]{}*]+/g) ?? [];
}

export function compileTemplate(source: string): Template {
  const slots: string[] = [];
  const tokens = templateTokens(source);
  // Every token eats the space before it, and the sentence is matched with a leading space, so optional tokens
  // anywhere (first, middle, last) need no special cases.
  let re = "^";
  for (const t of tokens) {
    if (t === "*") re += "(?: .+?)?";
    else if (t.startsWith("{")) {
      const name = t.slice(1, -1);
      if (slots.includes(name)) throw new Error(`template "${source}": slot {${name}} twice`);
      slots.push(name);
      re += ` (?<${name}>.+?)`;
    } else if (t.startsWith("(")) re += ` (?:${alternatives(t.slice(1, -1))})`;
    else if (t.startsWith("[")) re += `(?: (?:${alternatives(t.slice(1, -1))}))?`;
    else re += ` ${esc(t)}`;
  }
  return { source, re: new RegExp(re + "$"), slots };
}

/** The slot values when the template matches the whole sentence, else undefined. */
export function matchTemplate(t: Template, text: string): Record<string, string> | undefined {
  const m = t.re.exec(` ${text}`);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const name of t.slots) out[name] = m.groups![name]!.trim();
  return out;
}
