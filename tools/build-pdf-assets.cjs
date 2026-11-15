// PDF.js는 브라우저에서만 사용한다. Worker 런타임 번들에는 포함하지 않는다.
const fs = require('node:fs');
const path = require('node:path');
const source = path.dirname(require.resolve('pdfjs-dist/package.json'));
const target = path.resolve(__dirname, '../public/pdf-runtime');
fs.mkdirSync(target, { recursive: true });
for (const name of ['pdf.mjs', 'pdf.worker.mjs']) fs.copyFileSync(path.join(source, 'build', name), path.join(target, name));
for (const name of ['cmaps', 'standard_fonts']) fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true });
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(target, 'LICENSE'));
require('esbuild').buildSync({entryPoints:[path.join(__dirname,'pdf-selection-entry.mjs')],outfile:path.join(target,'selection.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022'});
console.log('PDF browser assets prepared');
