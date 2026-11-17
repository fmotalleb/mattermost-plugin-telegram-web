const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {execFileSync, spawnSync} = require('child_process');

const script = path.join(__dirname, 'package.js');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tgw-package-test-'));
try {
    const source = `${JSON.stringify(manifest, null, 4)}\n`;
    fs.writeFileSync(path.join(root, 'plugin.json'), source);
    for (const file of ['assets/icon.svg', 'public/pdfjs/test/worker.mjs', 'public/webapp/telegram-ui.test.js', 'public/webapp/fonts/emoji.test.woff2', 'webapp/dist/main.js', ...Object.values(manifest.server.executables)]) {
        const destination = path.join(root, file);
        fs.mkdirSync(path.dirname(destination), {recursive: true});
        fs.writeFileSync(destination, file);
        if (file.startsWith('server/')) fs.chmodSync(destination, 0o755);
    }
    fs.writeFileSync(path.join(root, 'public/webapp/manifest.json'), JSON.stringify({files:['public/webapp/telegram-ui.test.js','public/webapp/fonts/emoji.test.woff2']}));
    const archives = [];
    for (const [platform, executable] of Object.entries(manifest.server.executables)) {
        execFileSync(process.execPath, [script, platform], {cwd: root, stdio: 'pipe'});
        const name = `${manifest.id}-${manifest.version}-${platform}.tar.gz`;
        archives.push(name);
        const archive = path.join(root, 'release', name);
        const unpacked = path.join(root, platform);
        fs.mkdirSync(unpacked);
        execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
        const packaged = JSON.parse(fs.readFileSync(path.join(unpacked, 'plugin.json'), 'utf8'));
        assert.deepEqual(packaged.server.executables, {[platform]: executable});
        assert.equal(packaged.version, manifest.version);
        assert.equal(packaged.webapp.bundle_path, manifest.webapp.bundle_path);
        assert.deepEqual(fs.readdirSync(path.join(unpacked, 'server/dist')), [path.basename(executable)]);
        assert.equal(fs.readFileSync(path.join(unpacked, executable), 'utf8'), executable);
        assert.equal(fs.statSync(path.join(unpacked, executable)).mode & 0o777, 0o755);
        for (const file of ['assets/icon.svg', 'public/pdfjs/test/worker.mjs', 'public/webapp/telegram-ui.test.js', 'public/webapp/fonts/emoji.test.woff2', 'webapp/dist/main.js']) {
            assert.equal(fs.readFileSync(path.join(unpacked, file), 'utf8'), file);
        }
        const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
        assert.equal(fs.readFileSync(`${archive}.sha256`, 'utf8'), `${hash}  ${name}\n`);
        console.log(`  ok - ${platform} archive, executable, manifest, shared assets and checksum`);
    }
    assert.equal(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'), source);
    assert.equal(fs.readdirSync(path.join(root, 'release')).length, archives.length * 2);
    assert.notEqual(spawnSync(process.execPath, [script, 'linux-unknown'], {cwd: root}).status, 0);
    const existing = path.join(root, 'release', archives[0]);
    const before = fs.readFileSync(existing);
    fs.unlinkSync(path.join(root, 'public/webapp/telegram-ui.test.js'));
    assert.notEqual(spawnSync(process.execPath, [script, 'linux-amd64'], {cwd: root}).status, 0);
    assert.deepEqual(fs.readFileSync(existing), before);
    fs.unlinkSync(path.join(root, 'webapp/dist/main.js'));
    assert.notEqual(spawnSync(process.execPath, [script, 'linux-amd64'], {cwd: root}).status, 0);
    assert.deepEqual(fs.readFileSync(existing), before);
    console.log('PACKAGE TEST PASSED');
} finally {
    fs.rmSync(root, {recursive: true, force: true});
}
