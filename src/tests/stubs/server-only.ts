// Test-only stub for the "server-only" package.
//
// "server-only" enforces its guard via a package.json `exports` condition
// that only Next.js's bundler sets (the "react-server" condition); under
// plain Node/Vitest it always resolves to a throwing stub, which would
// break every test that imports src/db/client.ts or src/db/tenant.ts.
// vitest.config.ts aliases "server-only" to this no-op so the *tests* skip
// the guard while the real Next.js build still enforces it.
export {};
