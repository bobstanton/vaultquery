import { version } from '../../node_modules/sql.js/package.json';

export const CDN_URL = `https://cdn.jsdelivr.net/npm/sql.js@${version}/dist/sql-wasm.wasm`;
export const WASM_CACHE_FILENAME = `sql-wasm-${version}.wasm`;
