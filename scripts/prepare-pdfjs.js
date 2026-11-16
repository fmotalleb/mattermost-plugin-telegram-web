// Copy only the PDF.js runtime into Mattermost's static public directory. No CDN or
// webpack chunk loader is involved; the browser imports these files on first PDF open.
const fs = require('fs');
const path = require('path');

function preparePDFJS() {
    const source = path.dirname(require.resolve('../webapp/node_modules/pdfjs-dist/package.json'));
    const {version} = require(path.join(source, 'package.json'));
    const root = path.join(__dirname, '..', 'public', 'pdfjs');
    const output = path.join(root, version);
    fs.rmSync(root, {recursive: true, force: true});
    fs.mkdirSync(output, {recursive: true});
    // The legacy build includes compatibility polyfills for older desktop Chromium versions.
    for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
        fs.copyFileSync(path.join(source, 'legacy', 'build', file), path.join(output, file));
    }
    for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
        fs.cpSync(path.join(source, directory), path.join(output, directory), {recursive: true});
    }
    fs.copyFileSync(path.join(source, 'LICENSE'), path.join(output, 'LICENSE'));
    fs.writeFileSync(path.join(output, 'NOTICE'), `PDF.js ${version}\nhttps://github.com/mozilla/pdf.js\nMozilla Foundation and contributors. Licensed under Apache-2.0; see LICENSE.\n`);
}

module.exports = preparePDFJS;
if (require.main === module) preparePDFJS();
