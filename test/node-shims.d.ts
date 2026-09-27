/**
 * The only Node API the tests use, declared by hand.
 *
 * The engine itself is browser-only and `tsconfig` sets `"types": []` so no
 * ambient Node types leak into it. The tests need to read fixture bytes, so
 * this declares just that one function.
 */
declare module "node:fs" {
  export function readFileSync(path: string | URL): Uint8Array;
  export function existsSync(path: string): boolean;
}
