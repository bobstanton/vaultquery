import dts from 'rollup-plugin-dts';

export default {
  input: 'src/api.ts',
  output: { file: 'api.d.ts', format: 'es' },
  external: (id) => !id.startsWith('.') && !id.startsWith('/'),
  plugins: [dts()],
};
