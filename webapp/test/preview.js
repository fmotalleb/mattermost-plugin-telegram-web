/*
 * Renders the plugin UI once with the test fixture and writes a static, fully self-contained HTML
 * snapshot of the result to docs/ui-preview.html (light) and docs/ui-preview-dark.html.
 *
 * This is a documentation artifact: it is generated from the real components and the real
 * styles.css, so it shows exactly what the plugin draws (minus interactivity and minus the pictures
 * of the fake users, which cannot be loaded from a non existing server).
 *
 *   npm run preview
 */

const fs = require('fs');
const path = require('path');

const {
    React, ReactDOM: ReactDOMClient, container, users, tick,
} = require('./harness');

// The fixture's users have a `last_picture_update`, which makes the avatar component point an <img>
// at a server that does not exist here. Dropping it makes the avatars fall back to their initials.
Object.values(users).forEach((user) => {
    delete user.last_picture_update;
});

const {setStore} = require('../src/mm/store');
const {initSettings, updateSettings} = require('../src/mm/settings');
const {TelegramUI} = require('../src/ui/TelegramUI');
const {store} = require('./harness');

const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

setStore(store);
initSettings();
updateSettings({mode: 'on', theme: 'light'});

const root = ReactDOMClient.createRoot(container);

const page = (body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Telegram Web UI for Mattermost - rendered preview</title>
<style>
/* The plugin's own stylesheet, exactly as webpack inlines it into the bundle. */
${styles}
/* Chromeless page so the fixed-position overlay fills the frame. */
html, body { margin: 0; height: 100%; background: #0f0f0f; }
</style>
</head>
<body>
${body}
</body>
</html>
`;

const docs = path.join(__dirname, '..', '..', 'docs');
fs.mkdirSync(docs, {recursive: true});

(async () => {
    root.render(React.createElement(TelegramUI));
    await tick(150);

    // A chat with an image viewer / info panel open would need interaction, so the snapshot shows
    // the default state: chat list with contacts, groups and a custom folder, plus an open chat.
    const light = document.body.innerHTML;
    fs.writeFileSync(path.join(docs, 'ui-preview.html'), page(light));

    updateSettings({theme: 'dark', accent: 'violet'});
    await tick(120);
    fs.writeFileSync(path.join(docs, 'ui-preview-dark.html'), page(document.body.innerHTML));

    // eslint-disable-next-line no-console
    console.log('wrote docs/ui-preview.html and docs/ui-preview-dark.html');
    root.unmount();
    process.exit(0);
})();
