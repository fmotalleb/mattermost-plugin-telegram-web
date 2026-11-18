const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const root = path.join(__dirname, '..', '..');
const entry = fs.readFileSync(path.join(root, 'webapp/dist/main.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/webapp/manifest.json'), 'utf8'));
assert(Buffer.byteLength(entry) < 128 * 1024, 'disabled-startup entry must stay below 128 KiB');
assert(!entry.includes('data:font/woff2;base64'), 'fonts must not be inlined in the startup entry');
assert(!entry.includes('Invalid PDF structure.'), 'PDF.js must stay outside the startup entry');
for (const name of ['telegram-ui', 'imageviewer', 'emoji-picker', 'modals', 'mermaid-engine']) {
    assert(manifest.files.some((file) => file.startsWith(`public/webapp/${name}.`) && file.endsWith('.js')), `${name} must ship as a separate lazy chunk`);
}
for (const name of ['Vazirmatn-Variable', 'Twemoji']) {
    assert(manifest.files.some((file) => file.startsWith(`public/webapp/fonts/${name}.`) && file.endsWith('.woff2')), `${name} must ship as a separate font asset`);
}
for (const tile of ['0-0', '0-1', '1-0', '1-1']) {
    assert(manifest.files.some((file) => file.startsWith(`public/webapp/emoji/apple-${tile}.`) && file.endsWith('.webp')), `Apple emoji tile ${tile} must be packaged separately`);
}
for (const file of manifest.files) {
    assert(file.startsWith('public/webapp/') && !file.includes('..'), 'asset paths must remain inside plugin public assets');
    assert(fs.statSync(path.join(root, file)).size > 0, `${file} is required at runtime`);
}
console.log(`LAZY ASSETS TEST PASSED (startup entry: ${Buffer.byteLength(entry)} bytes)`);
