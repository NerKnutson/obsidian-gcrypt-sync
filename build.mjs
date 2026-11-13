import * as esbuild from 'esbuild';
await esbuild.build({
  entryPoints: ['src/main.js'], bundle: true, outfile: 'dist/main.js', format: 'cjs', platform: 'browser',
  target: 'es2020', external: ['obsidian', 'electron'], minify: true, legalComments: 'none', logLevel: 'info',
});
