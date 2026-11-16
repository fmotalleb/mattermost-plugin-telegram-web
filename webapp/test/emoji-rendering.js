const {React, ReactDOM, container, tick, ok, report} = require('./harness');
const {splitEmoji} = require('../src/mm/emoji');
const {wrapEmojiNodes} = require('../src/ui/render');
const {ReactionEmoji} = require('../src/ui/MessageList');

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
    root.unmount();
    report('EMOJI RENDERING TEST');
})().catch((error) => { console.error(error); root.unmount(); process.exitCode = 1; });
