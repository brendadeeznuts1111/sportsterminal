declare module 'fast-geoip' {
  interface GeoIpResult {
    range: [number, number];
    country: string;
    region: string;
    eu: string;
    timezone: string;
    city: string;
    ll: [number, number];
    metro: number;
    area: number;
  }
  export function lookup(ip: string): Promise<GeoIpResult | null>;
}
