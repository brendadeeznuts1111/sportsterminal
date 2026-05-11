export function decodeEntities(value: string): string {
  return value
    .replace(/&#189;/g, "\u00BD")
    .replace(/&#188;/g, "\u00BC")
    .replace(/&#190;/g, "\u00BE")
    .replace(/&#038;/g, "&")
    .replace(/&amp;/g, "&");
}