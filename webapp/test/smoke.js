/*
 * Smoke test for the Telegram Web UI plugin.
 *
 * Runs the real plugin UI (the same modules that get bundled for Mattermost) inside jsdom against
 * a simulated Mattermost Redux store and REST API. It catches runtime errors in the render path,
 * in the selectors and in the click handlers without needing a Mattermost server.
 *
 *   npm run test:smoke
 *
 * The jsdom environment, the fake store and the fetch stub live in test/harness.js.
 */

const {
    dom, React, ReactDOM: ReactDOMClient, container, calls, payloads,
    store, state, posts, ids, tick, ok, fail, report,
} = require('./harness');

// --------------------------------------------------------------------------- mount
const {setStore} = require('../src/mm/store');
const {initSettings, updateSettings, getSettings} = require('../src/mm/settings');
const {handleSocketEvent} = require('../src/mm/socket');
const {TelegramUI} = require('../src/ui/TelegramUI');

setStore(store);
initSettings();
updateSettings({mode: 'on', theme: 'light'});

// Waits until a condition holds, so assertions do not depend on how long a render takes.
// Returns the first truthy value the predicate produced, so it can also hand back the found node.
async function waitFor(predicate, timeout = 1500) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = predicate();
        if (value) {
            return value;
        }
        if (Date.now() >= deadline) {
            return predicate();
        }
        await tick(30);
    }
}

const root = ReactDOMClient.createRoot(container);
root.render(React.createElement(TelegramUI));

(async () => {
    await tick(80);

    const body = document.body.innerHTML;
    console.log('\n== render ==');
    ok(body.includes('tgw-root'), 'root overlay rendered');
    ok(body.includes('Alice Anderson'), 'DM chat row shows the peer name');
    ok(body.includes('Town Square'), 'public channel listed');
    ok(body.includes('Work stuff'), 'custom Mattermost category exposed as a folder');
    ok(body.includes('Mia Meyer'), 'user panel shows the current user');

    // Wait for the channel posts request of the initial chat.
    await tick(80);
    console.log('\n== messages ==');
    ok(document.body.innerHTML.includes('How are you'), 'loaded messages rendered');
    ok(document.body.innerHTML.includes('Deploy'), 'second message rendered');
    ok(document.body.innerHTML.includes('https://example.com/run'), 'links rendered');
    ok(document.querySelector('.tgw-messages').innerHTML.includes('😄') || document.body.innerHTML.includes(':smile:'), 'emoji shortcode rendered');
    ok(calls.some((call) => call.includes('/channels/channel-dm/posts')), 'messages were fetched through the REST API');
    ok(calls.some((call) => call.includes('/channels/members/user-me/view')), 'channel marked as read');
    ok(!!document.querySelector('.tgw-reaction'), 'reactions rendered');
    // The voice fixture is the newest DM post, so it must drive the sidebar preview as well.
    ok(Array.from(document.querySelectorAll('.tgw-chat-row')).some((row) => row.textContent.includes('Voice message')), 'sidebar preview shows the voice message');

    // Reaction toggles must update the local cache immediately, not after a reload.
    // One more tick: the MessageRow subscription effects (usePostRevision) must be registered
    // before the click, or the emit below has nobody to re-render for.
    await tick(30);
    const reactionChip = document.querySelector('.tgw-reaction');
    if (reactionChip) {
        ok(reactionChip.textContent.includes('1'), 'reaction starts with a single user');
        reactionChip.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-reaction')?.textContent.includes('2'));
        ok(calls.some((call) => call.includes('/reactions')), 'reaction toggle requested through the API');
        ok(document.querySelector('.tgw-reaction')?.textContent.includes('2'), 'reaction count updated without a reload');

        // Re-clicking a reaction I already joined must take mine away again.
        document.querySelector('.tgw-reaction')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-reaction')?.textContent.includes('1'));
        ok(calls.some((call) => call.startsWith('DELETE') && call.includes('/reactions')), 're-clicking my reaction removes it through the API');
        ok(document.querySelector('.tgw-reaction')?.textContent.includes('1'), 'reaction count drops back without a reload');
    }

    console.log('\n== reply ==');
    const replyButton = Array.from(document.querySelectorAll('.tgw-msg-toolbar button[title="Reply"]'))[0];
    ok(!!replyButton, 'reply action available on a message');
    if (replyButton) {
        replyButton.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await tick(60);
        ok(!!document.querySelector('.tgw-reply-bar'), 'reply bar opens under the composer');
        const replyArea = document.querySelector('.tgw-composer textarea');
        if (replyArea) {
            const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
            valueSetter.call(replyArea, 'this is a threaded reply');
            replyArea.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
            await tick(30);
            document.querySelector('.tgw-send-button').dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
            await tick(80);
            const replyPayload = payloads.find((entry) => entry.path === '/posts' && entry.body && entry.body.root_id);
            ok(!!replyPayload && !String(replyPayload.body.root_id).startsWith('pending-'), `reply was posted with the real root_id (got: ${JSON.stringify((payloads.filter((entry) => entry.path === '/posts').pop() || {}).body)})`);
            ok(!!document.querySelector('.tgw-msg-reply-preview'), 'sent reply renders with the reply preview');
            ok(document.body.innerHTML.includes('this is a threaded reply'), 'threaded reply message rendered');
            ok(!document.querySelector('.tgw-reply-bar'), 'reply bar closes after the reply was sent');
        } else {
            fail('composer textarea missing while replying');
        }
    }

    console.log('\n== attachments, thread, image viewer ==');
    const thumbs = document.querySelectorAll('.tgw-attachment-image');
    ok(thumbs.length >= 2, `image attachments render in the chat (${thumbs.length})`);

    const threadLink = document.querySelector('.tgw-thread-link');
    ok(!!threadLink, 'reply count link appears on the root post');
    if (threadLink) {
        threadLink.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => !!document.querySelector('.tgw-shell > .tgw-thread-panel'));
        ok(!!document.querySelector('.tgw-shell > .tgw-thread-panel'), 'thread opens as a right-hand column of the shell');
        await waitFor(() => !!document.querySelector('.tgw-thread-panel .tgw-attachment-image'));
        ok(!!document.querySelector('.tgw-thread-panel .tgw-attachment-image'), 'attachments render inside the thread panel');
        await waitFor(() => !!document.querySelector('.tgw-thread-panel .tgw-thread-goto'));
        const gotoButton = document.querySelector('.tgw-thread-panel .tgw-thread-goto');
        ok(!!gotoButton, 'go to message link is available in the thread');
        if (gotoButton) {
            gotoButton.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
            await waitFor(() => !document.querySelector('.tgw-thread-panel'));
            ok(!document.querySelector('.tgw-thread-panel'), 'go to message closes the thread panel');
            await waitFor(() => !!document.querySelector('.tgw-post-highlight'));
            ok(!!document.querySelector('.tgw-post-highlight'), 'go to message highlights the message in the chat');
        }
    }

    const firstThumb = document.querySelector('.tgw-attachment-image');
    if (firstThumb) {
        firstThumb.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await tick(60);
        ok(!!document.querySelector('.tgw-image-viewer'), 'image viewer opens from an attachment');
        const firstSrc = document.querySelector('.tgw-image-viewer-body img')?.getAttribute('src') || '';
        ok(firstSrc.includes('file-1'), `viewer starts on the clicked image (${firstSrc})`);
        ok(!!document.querySelector('.tgw-image-viewer-next'), 'prev/next controls appear when the chat has several images');
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
        await tick(60);
        const secondSrc = document.querySelector('.tgw-image-viewer-body img')?.getAttribute('src') || '';
        ok(secondSrc.includes('file-2'), `ArrowRight moves to the next image (${secondSrc})`);
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'ArrowLeft', bubbles: true}));
        await tick(60);
        const backSrc = document.querySelector('.tgw-image-viewer-body img')?.getAttribute('src') || '';
        ok(backSrc.includes('file-1'), `ArrowLeft moves back (${backSrc})`);
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        await tick(60);
        ok(!document.querySelector('.tgw-image-viewer'), 'Escape closes the image viewer');
    } else {
        fail('attachment thumbnail missing');
    }

    console.log('\n== voice messages ==');
    const voicePlayer = document.querySelector('.tgw-voice');
    ok(!!voicePlayer, 'voice message renders with the player');
    ok(!!document.querySelector('.tgw-voice .tgw-voice-play'), 'voice player has a play button');
    const voiceBars = document.querySelectorAll('.tgw-voice .tgw-voice-bar').length;
    ok(voiceBars > 0, `voice waveform rendered (${voiceBars} bars)`);
    ok(/^\d+:\d\d$/.test((document.querySelector('.tgw-voice-duration')?.textContent || '').trim()), 'voice duration label rendered');
    if (voicePlayer) {
        const playButton = voicePlayer.querySelector('.tgw-voice-play');
        playButton.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await tick(30);
        ok(!!document.querySelector('.tgw-voice-play.tgw-voice-playing'), 'clicking play toggles the player into the playing state');
        playButton.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await tick(30);
        ok(!document.querySelector('.tgw-voice-play.tgw-voice-playing'), 'clicking again pauses the player');
    }

    const micButton = document.querySelector('.tgw-composer-icon[title="Record a voice message"]');
    ok(!!micButton, 'microphone button available in the composer');
    if (micButton) {
        micButton.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => !!document.querySelector('.tgw-voice-recording'));
        ok(!!document.querySelector('.tgw-voice-recording'), 'clicking the microphone starts a recording');
        await waitFor(() => document.querySelectorAll('.tgw-rec-bar').length > 1);
        ok(document.querySelectorAll('.tgw-rec-bar').length > 1, 'live waveform renders while recording');
        ok(/^\d+:\d\d$/.test((document.querySelector('.tgw-rec-timer')?.textContent || '').trim()), 'recording timer rendered');
        ok(!document.querySelector('.tgw-composer textarea'), 'the text input is replaced while recording');

        const stopButton = document.querySelector('.tgw-voice-stop');
        ok(!!stopButton, 'stop control shown while recording');
        if (stopButton) {
            stopButton.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
            await waitFor(() => !!document.querySelector('.tgw-attachment-chip-voice'));
            ok(!!document.querySelector('.tgw-attachment-chip-voice'), 'finished take lands in the attachment tray');
            ok(calls.some((call) => call === 'POST /files'), 'voice take uploaded through the file API');
            await waitFor(() => !document.body.innerHTML.includes('Uploading…'));
            ok(!document.body.innerHTML.includes('Uploading…'), 'voice take finished uploading');

            document.querySelector('.tgw-send-button').dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
            const voicePost = await waitFor(() => payloads.find((entry) => entry.path === '/posts' && entry.body && Array.isArray(entry.body.file_ids) && entry.body.file_ids.length));
            ok(!!voicePost, 'voice message posted with the uploaded file id');
            if (voicePost) {
                ok(voicePost.body.props?.voice?.fileId === voicePost.body.file_ids[0], 'voice metadata points at the uploaded file');
                ok(typeof voicePost.body.props?.voice?.durationMs === 'number', 'voice duration travels with the post');
                ok(Array.isArray(voicePost.body.props?.voice?.levels) && voicePost.body.props.voice.levels.length > 0, 'recorded waveform travels with the post');
            }
            await waitFor(() => document.querySelectorAll('.tgw-voice').length >= 2);
            ok(document.querySelectorAll('.tgw-voice').length >= 2, 'sent voice message renders in the chat');
            ok(!document.querySelector('.tgw-voice-recording'), 'composer returns to normal after the voice message was sent');
        }
    }

    console.log('\n== interactions ==');
    const townRow = Array.from(document.querySelectorAll('.tgw-chat-row')).find((row) => row.textContent.includes('Town Square'));
    ok(!!townRow, 'town square row found');
    if (townRow) {
        townRow.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await tick(60);
        ok(document.querySelector('.tgw-chat-header-title')?.textContent === 'Town Square', 'clicking a chat opens it');
        ok(calls.some((call) => call.includes('/channels/channel-town/posts')), 'posts of the opened chat requested');
    }

    const textarea = document.querySelector('.tgw-composer textarea');
    ok(!!textarea, 'composer available');
    if (textarea) {
        const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
        valueSetter.call(textarea, 'hello from the smoke test');
        textarea.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(30);
        const sendButton = document.querySelector('.tgw-send-button');
        sendButton.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await tick(60);
        ok(calls.some((call) => call === 'POST /posts'), 'composer sent a post through the API');
        ok(document.body.innerHTML.includes('hello from the smoke test'), 'optimistic message rendered');
    }

    console.log('\n== websocket ==');
    // Mattermost ships the post inside data.post as a JSON *string* (post.ToJson() on the server);
    // the raw string must be parsed or the cache silently ignores it.
    const wsPost = {...posts.p1, id: 'p-ws', create_at: Date.now(), channel_id: ids.TOWN, user_id: ids.OTHER, message: 'incoming over websocket', root_id: '', reply_count: 0, metadata: {}};
    handleSocketEvent('posted', {event: 'posted', data: {post: JSON.stringify(wsPost)}});
    await tick(60);
    ok(document.body.innerHTML.includes('incoming over websocket'), 'websocket post appears in the open chat');

    const wsReply = {...wsPost, id: 'p-ws-reply', root_id: 'p-ws', message: 'reply over websocket'};
    handleSocketEvent('posted', {event: 'posted', data: {post: JSON.stringify(wsReply)}});
    await tick(60);
    ok(document.body.innerHTML.includes('reply over websocket'), 'websocket reply appears in the open chat');
    ok(document.querySelector('.tgw-thread-link')?.textContent.includes('1 reply'), 'reply counter updates without a reload');

    // Reactions over the socket, in both directions.
    const wsReaction = {user_id: ids.OTHER, post_id: 'p-ws', emoji_name: 'tada', create_at: Date.now()};
    handleSocketEvent('reaction_added', {event: 'reaction_added', data: {reaction: JSON.stringify(wsReaction)}});
    await tick(60);
    ok(document.querySelector('.tgw-reaction')?.textContent.includes('1'), 'reaction added over the websocket renders');
    handleSocketEvent('reaction_removed', {event: 'reaction_removed', data: {reaction: JSON.stringify(wsReaction)}});
    await tick(60);
    ok(!document.querySelector('.tgw-reaction'), 'reaction removed over the websocket disappears immediately');

    // A post in a chat that is not open still refreshes that chat's sidebar preview.
    handleSocketEvent('posted', {event: 'posted', data: {post: JSON.stringify({...posts.p1, id: 'p-preview', create_at: Date.now(), channel_id: ids.DM, message: 'newest in the dm', root_id: '', metadata: {}})}});
    await tick(60);
    ok(document.body.innerHTML.includes('newest in the dm'), 'chat list preview updates for a channel that is not open');

    console.log('\n== search ==');
    const searchInput = document.querySelector('.tgw-search input');
    if (searchInput) {
        const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
        valueSetter.call(searchInput, 'Alice');
        searchInput.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(60);
        ok(document.body.innerHTML.includes('Contacts'), 'global search renders contact results');
    } else {
        fail('search input missing');
    }

    console.log('\n== settings ==');
    ok(getSettings().mode === 'on', 'plugin settings loaded (server default applied)');

    updateSettings({accent: 'violet', compactMode: true, theme: 'dark'});
    await tick(60);
    const rootEl = document.querySelector('.tgw-root');
    ok(!!rootEl && rootEl.classList.contains('tgw-accent-violet'), 'accent setting is applied to the root element');
    ok(!!rootEl && rootEl.classList.contains('tgw-compact'), 'compact mode is applied to the root element');
    ok(!!rootEl && rootEl.classList.contains('tgw-theme-dark'), 'theme setting is applied to the root element');

    console.log('\n== api calls observed ==');
    calls.slice(0, 12).forEach((call) => console.log(`  ${call}`));

    await tick(30);
    root.unmount();
    report('SMOKE TEST');
    process.exit(process.exitCode || 0);
})().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
});
