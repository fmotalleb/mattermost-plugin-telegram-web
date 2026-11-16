const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const {version} = require('pdfjs-dist/package.json');
const base = path.join(__dirname, '..', '..', 'public', 'pdfjs', version);
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs', 'LICENSE', 'NOTICE']) {
    assert(fs.statSync(path.join(base, file)).size > 0, `${file} must ship with the plugin`);
}
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
    assert(fs.readdirSync(path.join(base, dir)).length > 0, `${dir} must be available offline`);
}
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    assert.equal(fs.readFileSync(path.join(base, file), 'utf8'),
        fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', file), 'utf8'), 'renderer and worker use the same pinned version');
}
const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'main.js'), 'utf8');
assert(!bundle.includes('Invalid PDF structure.'), 'PDF engine must remain outside the startup bundle');
assert(bundle.includes('pdf.min.mjs') && bundle.includes('pdf.worker.min.mjs'), 'bundle loads the packaged PDF modules');
console.log('PDF ASSETS TEST PASSED');
