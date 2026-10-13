// Applies a version number (typically stripped from a git tag) to the two files that carry the
// plugin version: plugin.json (what Mattermost reads) and webapp/package.json (the node app).
//
//   node scripts/version.js 1.2.3
//   make version VERSION=v1.2.3      # a leading "v" is accepted and stripped
//
// The release workflow runs this from the pushed tag before building, so the tarball name and the
// manifest inside it always match the tag.

const fs = require('fs');
const path = require('path');

const raw = process.argv[2] || '';
const version = raw.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(`scripts/version.js: "${raw}" is not a version like 1.2.3`);
    process.exit(1);
}

const root = path.join(__dirname, '..');

function stamp(relative, pick = (data) => [data]) {
    const file = path.join(root, relative);
    const original = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(original);
    const targets = pick(data).filter(Boolean);
    if (targets.every((target) => target.version === version)) {
        console.log(`${relative}: ${version} (already set)`);
        return;
    }
    for (const target of targets) {
        target.version = version;
    }
    // Keep the file's existing indentation; everything else (key order) is preserved.
    const indent = (original.match(/^([ \t]+)"/m) || [null, '    '])[1];
    fs.writeFileSync(file, `${JSON.stringify(data, null, indent)}\n`);
    console.log(`${relative}: ${version}`);
}

stamp('plugin.json');
stamp(path.join('webapp', 'package.json'));
// npm keeps the root version in the lockfile too (top level and packages[""]); stamping it here
// means `npm ci` stays in sync and a later `npm install` has nothing to rewrite.
stamp(path.join('webapp', 'package-lock.json'), (lock) => [lock, lock.packages && lock.packages['']]);
