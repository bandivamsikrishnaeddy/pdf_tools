/**
 * Ambient declarations for the Vite build.
 *
 * `types` is empty in tsconfig so no Node globals leak into the engine, which
 * has to run in a browser. These are the only two things the app layer needs.
 */

/// <reference types="vite/client" />

declare module "*.css";
