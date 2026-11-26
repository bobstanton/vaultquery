import dts from 'rollup-plugin-dts';

export default [
  ['src/api.ts', 'api.d.ts'],
  ['src/Providers/TableProviderTypes.ts', 'provider-types.d.ts'],
].map(([input, file]) => ({
  input,
  output: { file, format: 'es' },
  external: (id) => id !== 'placeholder-resolver/core' && !id.startsWith('.') && !id.startsWith('/'),
  plugins: [dts({ tsconfig: './tsconfig.json', respectExternal: true })],
}));
