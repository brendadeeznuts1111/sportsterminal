/**
 * VENDORED from turbo-cap-valley-lion src/desk/teams/normalize.ts at
 * 4d484f3d (local stack branch cursor/teammeta-2-alias-normalization, not yet
 * pushed). Keep in sync by copying, not editing.
 */
/**
 * Team spelling normalization shared by the registry, the reference build and
 * the coverage test. Pure: no Bun or Node globals.
 *
 *   normTeam("San José State")  → "san jose state"
 *   normTeam("Texas A&M")       → "texas a and m"
 *   normTeam("Miami (OH)")      → "miami oh"
 *   teamVariants("los angeles rams") → ["la rams"]
 */

/** NFKD accent strip, lower case, `&` → `and`, every other non-alphanumeric run → one space. */
export function normTeam(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Book shortenings, both directions, on whole leading tokens. `l a` is what `L.A.` normalizes to. */
const PREFIXES: readonly (readonly [string, string])[] = [
  ["los angeles ", "la "],
  ["los angeles ", "l a "],
  ["new york ", "ny "],
  ["new york ", "n y "],
];

/**
 * Other spellings of an already normalized form: `St`/`State` either way on a
 * whole token, and the `LA`/`NY` prefixes either way. Never includes the input.
 */
export function teamVariants(form: string): string[] {
  const out = new Set<string>();
  const words = form.split(" ");
  const swapped = words.map((w) => (w === "state" ? "st" : w === "st" ? "state" : w));
  if (swapped.join(" ") !== form) out.add(swapped.join(" "));
  for (const base of [form, ...out]) {
    for (const [long, short] of PREFIXES) {
      if (base.startsWith(long)) out.add(short + base.slice(long.length));
      else if (base.startsWith(short)) out.add(long + base.slice(short.length));
    }
  }
  out.delete(form);
  return [...out];
}
