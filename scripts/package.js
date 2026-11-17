// Package an already built webapp and one server executable. Run from the repository root.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {execFileSync} = require('child_process');

const root = process.cwd();
const platform = process.argv[2] || 'linux-amd64';
const releaseDir = path.resolve(process.argv[3] || 'release');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
const executable = manifest.server.executables[platform];
if (!executable || !/^(linux-(amd64|arm|arm64|riscv64)|darwin-(amd64|arm64))$/.test(platform)) {
    throw new Error(`Unsupported platform: ${platform}`);
}

// Fail before touching an existing archive when an input is missing.
for (const input of [executable, 'webapp/dist/main.js', 'assets', 'public']) {
    if (!fs.existsSync(path.join(root, input))) throw new Error(`Missing build input: ${input}`);
}
manifest.server.executables = {[platform]: executable};
fs.mkdirSync(releaseDir, {recursive: true});
const staging = fs.mkdtempSync(path.join(releaseDir, `.package-${platform}-`));
const name = `${manifest.id}-${manifest.version}-${platform}.tar.gz`;
const archive = path.join(releaseDir, name);
const temporaryArchive = path.join(staging, name);
try {
    const contents = path.join(staging, 'contents');
    fs.mkdirSync(contents);
    fs.writeFileSync(path.join(contents, 'plugin.json'), `${JSON.stringify(manifest, null, 4)}\n`);
    for (const input of ['assets', 'public', 'webapp/dist/main.js', executable]) {
        const destination = path.join(contents, input);
        fs.mkdirSync(path.dirname(destination), {recursive: true});
        fs.cpSync(path.join(root, input), destination, {recursive: true});
    }
    execFileSync('tar', ['-czf', temporaryArchive, '-C', contents, '.']);
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(temporaryArchive)).digest('hex');
    fs.renameSync(temporaryArchive, archive);
    fs.writeFileSync(`${archive}.sha256`, `${checksum}  ${name}\n`);
    console.log(`packaged ${archive}`);
} finally {
    fs.rmSync(staging, {recursive: true, force: true});
}
