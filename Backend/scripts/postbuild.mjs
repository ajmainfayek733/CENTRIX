import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Marks the compiled output as CommonJS.
 *
 * `package.json` declares `"type": "module"` (tsx and prisma.config.ts want ESM), but tsconfig
 * emits `"module": "commonjs"`. Without this file Node reads the root type declaration, treats
 * every `dist/*.js` as ESM, and dies on the first `exports` reference — so `npm start` and any
 * container built from it fail immediately while `npm run dev` works fine.
 *
 * Writing a nested package.json scopes the CommonJS declaration to dist/ only, which is the
 * least invasive fix: switching the emit to real ESM would mean adding explicit `.js`
 * extensions to every relative import in the codebase.
 */
mkdirSync('dist', { recursive: true });
writeFileSync('dist/package.json', `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

console.log('postbuild: marked dist/ as CommonJS');
