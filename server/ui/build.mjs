import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';

const watch = process.argv.includes('--watch');

const opts = {
  entryPoints: {
    'panel/panel': 'panel/main.js',
    'config/config': 'config/main.js',
  },
  bundle: true,
  outdir: '../static',
  format: 'iife',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

function copyStatics() {
  for (const dir of ['panel', 'config']) {
    mkdirSync(`../static/${dir}`, { recursive: true });
    copyFileSync(`${dir}/index.html`, `../static/${dir}/index.html`);
    copyFileSync(`${dir}/${dir}.css`,  `../static/${dir}/${dir}.css`);
  }
}

if (watch) {
  copyStatics();
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(opts);
  copyStatics();
}
