import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync('src/api.ts', 'utf8');

const declaration = source
  .replace(/from '\.\//g, "from './src/")
  .replace(/import\('\.\//g, "import('./src/");

writeFileSync('api.d.ts', declaration);
