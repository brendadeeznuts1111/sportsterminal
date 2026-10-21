/**
 * Team identity for odds events: the turbo-cap team registry (ESPN reference,
 * desk overrides, donor spellings) vendored beside this file. Lookups are
 * league-scoped; a name the league does not know, or knows ambiguously,
 * resolves to null and the provider keeps the raw name.
 */
import authored from './teams.authored.json';
import donors from './teams.donors.json';
import ref from './teams.ref.json';
import { normTeam } from './normalize';
import { buildTeamIndex, type AuthoredTeams, type DonorForms } from './team-index';
import type { RefTeam, TeamsDonors, TeamsRef } from './types';

const REF = ref as TeamsRef;
const INDEX = buildTeamIndex(authored as AuthoredTeams, REF, (donors as TeamsDonors).teams as DonorForms);

export interface RegistryTeam {
  league: string;
  /** Registry abbreviation, e.g. "LAL". */
  abbr: string;
  espnId: string | null;
  displayName: string;
  /** ESPN logo URL (default variant), or null when the registry has none. */
  logo: string | null;
  /** `#rrggbb` ESPN primary color, or null. */
  color: string | null;
}

/** The registry team `raw` names in `league` ("NBA", "LIGA MX", ...), or null. */
export function resolveTeam(league: string, raw: string): RegistryTeam | null {
  const l = league.trim().toUpperCase();
  const form = normTeam(raw);
  if (!form || INDEX.ambiguous.get(l)?.has(form)) return null;
  const hit = INDEX.forms.get(l)?.get(form);
  const entry = hit ? INDEX.entries.get(l)?.get(hit.abbr) : null;
  if (!entry) return null;
  const team: RefTeam | null = entry.ref;
  return {
    league: l,
    abbr: entry.abbr,
    espnId: entry.espnId,
    displayName: entry.displayName,
    logo: team?.logos[0] ? `${REF.logoBase}${team.logos[0]}` : null,
    color: team?.color ? `#${team.color}` : null,
  };
}

/** Leagues the vendored reference covers. */
export const REGISTRY_LEAGUES: readonly string[] = Object.keys(REF.teams);
