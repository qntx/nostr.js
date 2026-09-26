// whatwg-url 7.x ships no TypeScript declarations; the Hermes shim only needs
// the two classes, matching the DOM globals it emulates.
declare module "whatwg-url" {
  export const URL: typeof globalThis.URL;
  export const URLSearchParams: typeof globalThis.URLSearchParams;
}
