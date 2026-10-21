/** Shapes of the vendored turbo-cap team artifacts (see README.md). */
export type RefTeam = {
  espnId: string;
  abbr: string;
  displayName: string;
  shortName: string;
  nickname: string | null;
  espnNickname: string | null;
  location: string | null;
  color: string | null;
  alternateColor: string | null;
  /** Paths under `logoBase`, default variant first. */
  logos: string[];
  active: boolean;
};

export type TeamsRef = {
  generatedBy: string;
  logoBase: string;
  fetchedAt: string;
  sources: string[];
  counts: Record<string, number>;
  leagues: Record<string, { sport: string; espnPath: string; floor: number }>;
  teams: Record<string, RefTeam[]>;
};

export type TeamsDonors = {
  generatedBy: string;
  sources: string[];
  teams: Record<string, Record<string, { form: string; donor: string }[]>>;
};
