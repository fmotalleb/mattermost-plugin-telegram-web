const {React, ReactDOM, container, tick, ok, report} = require('./harness');
const {splitEmoji} = require('../src/mm/emoji');
const {wrapEmojiNodes} = require('../src/ui/render');
const {ReactionEmoji} = require('../src/ui/MessageList');
const {Emoji} = require('../src/ui/Emoji');
const {DEFAULT_SETTINGS, initSettings, getSettings, updateSettings, refreshServerSettings} = require('../src/mm/settings');
const {setStore} = require('../src/mm/store');
const {store, dom, payloads} = require('./harness');

const root = ReactDOM.createRoot(container);
(async () => {
    const sequences = ['👍🏽', '👨‍👩‍👧‍👦', '🇮🇷', '1️⃣', '#️⃣', '*️⃣', '🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}'];
    for (const emoji of sequences) {
        const pieces = splitEmoji(`before ${emoji} after`);
        ok(pieces.length === 3 && pieces[1].emoji && pieces[1].text === emoji,
            `${emoji} stays one complete emoji grapheme`);
    }
    const HostEmoji = () => React.createElement('b', null, 'host artwork');
    root.render(wrapEmojiNodes(React.createElement('div', null,
        'typed 😀 ',
        React.createElement('img', {className: 'emoticon', src: '/host/smile.png', alt: ':smile:'}),
        React.createElement(HostEmoji, {emojiName: 'thumbsup'}),
        React.createElement('span', {'data-emoticon': 'heart', className: 'emoticon'}, ':heart:'),
        React.createElement('img', {className: 'emoji', src: '/api/v4/emoji/custom/image', alt: ':smile:'}),
        React.createElement('code', null, ':smile: 😀'))));
    await tick(50);
    const wrapped = Array.from(container.querySelectorAll('.tgw-emoji')).map((node) => node.textContent);
    ok(wrapped.join('') === '😀😄👍❤️', 'typed emoji and standard host images/components use the internal artwork font');
    ok(!container.querySelector('b'), 'standard host emoji components do not paint their own artwork');
    ok(container.querySelectorAll('img').length === 1 && container.querySelector('img').src.includes('/emoji/custom/'),
        'custom workspace images are preserved even if their name matches a standard emoji');
    ok(container.querySelector('code').textContent === ':smile: 😀' && !container.querySelector('code .tgw-emoji'),
        'code keeps its literal text');
    root.render(React.createElement('div', null,
        React.createElement(ReactionEmoji, {name: 'thumbsup', customEmoji: {}}),
        React.createElement(ReactionEmoji, {name: 'not_a_known_emoji', customEmoji: {}}),
        React.createElement(ReactionEmoji, {name: 'party', customEmoji: {party: {id: 'custom'}}})));
    await tick(30);
    ok(container.querySelector('span.tgw-reaction-emoji')?.textContent === '👍', 'standard reactions use an emoji cell');
    ok(container.querySelector('.tgw-reaction-label')?.textContent === ':not_a_known_emoji:',
        'unknown reaction names remain readable text instead of overflowing a one-em cell');
    ok(container.querySelector('img.tgw-reaction-emoji')?.src.includes('/emoji/custom/'),
        'custom reactions retain their images in the same sized cell');
    ok(DEFAULT_SETTINGS.appleEmoji === false, 'Apple artwork requires explicit opt-in');
    root.render(React.createElement('div', null,
        React.createElement(Emoji, {char: '👍🏽'}),
        React.createElement(Emoji, {char: '👨‍👩‍👧‍👦'}),
        React.createElement(Emoji, {char: '1️⃣'}),
        React.createElement(Emoji, {char: '🫩‍🫩'})));
    await tick(30);
    const cells = container.querySelectorAll('span');
    ok(Array.from(cells).slice(0, 3).every((node) => node.classList.contains('tgw-apple-emoji') && node.style.getPropertyValue('--tgw-emoji-x')), 'skin tones, family sequences and keycaps have sprite positions');
    ok(!cells[3].classList.contains('tgw-apple-emoji') && cells[3].textContent === '🫩‍🫩', 'missing Apple artwork keeps the Unicode font fallback');
    // Old preferences must never override the administrator's value, including after hydration.
    setStore(store);
    dom.window.localStorage.setItem('tgw.settings.com.telegramweb.ui', JSON.stringify({appleEmoji: true}));
    const originalFetch = global.fetch;
    global.fetch = (url, options) => String(url).includes('/users/me/preferences') && (!options || !options.method || options.method === 'GET')
        ? Promise.resolve({ok: true, text: async () => JSON.stringify([{category:'com.telegramweb.ui', name:'settings', value:JSON.stringify({appleEmoji:true})}])})
        : originalFetch(url, options);
    globalThis.__appleEmoji = false;
    initSettings();
    await tick(80);
    ok(getSettings().appleEmoji === false, 'legacy local and remote opt-ins cannot override disabled server setting');
    updateSettings({appleEmoji: true});
    ok(getSettings().appleEmoji === false, 'user settings cannot change the server-wide emoji setting');
    globalThis.__appleEmoji = true;
    await refreshServerSettings();
    ok(getSettings().appleEmoji === true, 'server setting enables emoji for users with legacy preferences');
    dom.window.localStorage.setItem('tgw.settings.com.telegramweb.ui', JSON.stringify({appleEmoji: false}));
    global.fetch = (url, options) => String(url).includes('/users/me/preferences') && (!options || !options.method || options.method === 'GET')
        ? Promise.resolve({ok: true, text: async () => JSON.stringify([{category:'com.telegramweb.ui', name:'settings', value:JSON.stringify({appleEmoji:false})}])})
        : originalFetch(url, options);
    initSettings();
    await tick(80);
    ok(getSettings().appleEmoji === true, 'legacy local and remote opt-outs cannot override enabled server setting');
    await tick(450);
    ok(!Object.prototype.hasOwnProperty.call(JSON.parse(dom.window.localStorage.getItem('tgw.settings.com.telegramweb.ui')), 'appleEmoji'), 'server setting is not persisted as a user preference');
    const saved = payloads.filter((entry) => entry.method === 'PUT' && /\/preferences$/.test(entry.path)).flatMap((entry) => entry.body || []).find((entry) => entry.category === 'com.telegramweb.ui');
    ok(saved && !Object.prototype.hasOwnProperty.call(JSON.parse(saved.value), 'appleEmoji'), 'remote user preferences exclude the server setting');
    global.fetch = originalFetch;
    root.unmount();
    report('EMOJI RENDERING TEST');
})().catch((error) => { console.error(error); root.unmount(); process.exitCode = 1; });
