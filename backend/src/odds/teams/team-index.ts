/**
 * VENDORED from turbo-cap-valley-lion src/desk/aliases/team-index.ts at
 * 4d484f3d (local stack branch cursor/teammeta-2-alias-normalization, not yet
 * pushed). Keep in sync by copying, not editing.
 */
/**
 * The league-scoped team index: every ESPN reference team, the desk's own
 * abbreviations and spellings from `teams.jsonc`, and the donor tables, keyed
 * by normalized form within one league. A form is only ever compared inside
 * its league, so `KC` is the Chiefs in the NFL and the Royals in MLB; the 4C
 * table dropped such forms globally, this index does not.
 *
 * Precedence, lowest tier first: authored spellings (0), the abbreviations and
 * display name (1), short name, location + nickname and donor forms (2), bare
 * nickname and location (3). Each tier's `St`/`State` and `LA`/`NY` variants
 * rank just below it. Two teams claiming one form at the same best tier leave
 * it unresolved and listed in `ambiguous`.
 */
import { normTeam, teamVariants } from "./normalize";
import type { RefTeam, TeamsRef } from "./types";

export type AuthoredTeams = Record<string, Record<string, readonly string[]>>;
export type DonorForms = Record<string, Record<string, readonly { form: string; donor: string }[]>>;

export type TeamEntry = {
  league: string;
  /** The desk's canonical abbreviation: the authored one when `teams.jsonc` has the team, else ESPN's. */
  abbr: string;
  /** Long display name: the first authored spelling, else ESPN's display name. */
  displayName: string;
  shortName: string;
  espnId: string | null;
  ref: RefTeam | null;
  /** Exact forms (tiers 0 to 2) for vocabulary and proposals. */
  spellings: string[];
};

export type FormHit = { abbr: string; tier: number };

export type TeamIndex = {
  entries: Map<string, Map<string, TeamEntry>>;
  forms: Map<string, Map<string, FormHit>>;
  ambiguous: Map<string, Map<string, string[]>>;
  /** Authored entries that link to no single reference team, or abbreviations that shadow another team. */
  problems: string[];
};

function linkAuthored(abbr: string, names: readonly string[], rows: readonly RefTeam[]): RefTeam | null | "many" {
  const codes = new Set([abbr, ...names].map((n) => n.trim().toUpperCase()));
  const spelled = new Set(names.map(normTeam));
  const hits = rows.filter((t) => codes.has(t.abbr.toUpperCase()) || spelled.has(normTeam(t.displayName)));
  if (hits.length > 1) return "many";
  return hits[0] ?? null;
}

export function buildTeamIndex(authored: AuthoredTeams, ref: TeamsRef, donors: DonorForms): TeamIndex {
  const entries = new Map<string, Map<string, TeamEntry>>();
  const claims = new Map<string, Map<string, Map<string, number>>>();
  const problems: string[] = [];
  const claim = (league: string, abbr: string, raw: string | null | undefined, tier: number) => {
    if (!raw) return;
    const form = normTeam(raw);
    if (!form) return;
    const byForm = claims.get(league) ?? new Map<string, Map<string, number>>();
    claims.set(league, byForm);
    const hits = byForm.get(form) ?? new Map<string, number>();
    byForm.set(form, hits);
    const put = (f: string, t: number) => {
      const m = byForm.get(f) ?? new Map<string, number>();
      byForm.set(f, m);
      m.set(abbr, Math.min(m.get(abbr) ?? Infinity, t));
    };
    put(form, tier * 2);
    for (const v of teamVariants(form)) put(v, tier * 2 + 1);
  };
  const leagues = [...new Set([...Object.keys(ref.teams), ...Object.keys(authored)])];
  for (const league of leagues) {
    const rows = ref.teams[league] ?? [];
    const own = authored[league] ?? {};
    const byEspn = new Map<string, string>();
    const map = new Map<string, TeamEntry>();
    for (const [abbr, names] of Object.entries(own)) {
      const linked = linkAuthored(abbr, names, rows);
      if (linked === "many") {
        problems.push(`${league} ${abbr} links to more than one reference team`);
        continue;
      }
      if (rows.length && !linked) problems.push(`${league} ${abbr} links to no reference team`);
      if (linked && byEspn.has(linked.espnId)) problems.push(`${league} ${abbr} and ${byEspn.get(linked.espnId)} both link to ${linked.displayName}`);
      if (linked) byEspn.set(linked.espnId, abbr);
      map.set(abbr, { league, abbr, displayName: names[0] ?? linked?.displayName ?? abbr, shortName: linked?.shortName ?? names[0] ?? abbr, espnId: linked?.espnId ?? null, ref: linked, spellings: [] });
    }
    for (const t of rows) {
      if (byEspn.has(t.espnId)) continue;
      if (map.has(t.abbr)) {
        problems.push(`${league} ESPN ${t.abbr} (${t.displayName}) is shadowed by the authored ${t.abbr}`);
        continue;
      }
      map.set(t.abbr, { league, abbr: t.abbr, displayName: t.displayName, shortName: t.shortName, espnId: t.espnId, ref: t, spellings: [] });
    }
    for (const e of map.values()) {
      const tiers: [number, (string | null | undefined)[]][] = [
        [0, [e.abbr, ...(own[e.abbr] ?? [])]],
        [1, [e.ref?.abbr, e.ref?.displayName]],
        [2, [e.ref?.shortName, e.ref && e.ref.location && e.ref.nickname ? `${e.ref.location} ${e.ref.nickname}` : null, e.ref?.espnNickname, ...(e.espnId ? (donors[league]?.[e.espnId] ?? []) : []).map((d) => d.form)]],
        [3, [e.ref?.nickname, e.ref?.location]],
      ];
      const spellings = new Set<string>();
      for (const [tier, forms] of tiers) {
        for (const f of forms) {
          claim(league, e.abbr, f, own[e.abbr] && tier === 0 ? 0 : tier === 0 ? 1 : tier);
          if (f && tier <= 2) spellings.add(f.trim());
        }
      }
      e.spellings = [...spellings];
    }
    entries.set(league, map);
  }
  const forms = new Map<string, Map<string, FormHit>>();
  const ambiguous = new Map<string, Map<string, string[]>>();
  for (const [league, byForm] of claims) {
    const out = new Map<string, FormHit>();
    const amb = new Map<string, string[]>();
    for (const [form, hits] of byForm) {
      const best = Math.min(...hits.values());
      const top = [...hits].filter(([, t]) => t === best).map(([a]) => a).sort();
      if (top.length === 1) out.set(form, { abbr: top[0]!, tier: best });
      else amb.set(form, top);
    }
    forms.set(league, out);
    ambiguous.set(league, amb);
  }
  return { entries, forms, ambiguous, problems };
}
