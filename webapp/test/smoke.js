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
    store, state, posts, ids, tick, ok, fail, report, notifyStoreChange,
} = require('./harness');

// --------------------------------------------------------------------------- mount
const {setStore} = require('../src/mm/store');
const {initSettings, updateSettings, getSettings} = require('../src/mm/settings');
const {handleSocketEvent} = require('../src/mm/socket');
const {startStockUIViewTracking} = require('../src/mm/stock-views');
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
    // Wait for the first paint: cold-start module loading can outlast a fixed tick.
    await waitFor(() => document.body.innerHTML.includes('Alice Anderson'));

    const body = document.body.innerHTML;
    console.log('\n== render ==');
    ok(body.includes('tgw-root'), 'root overlay rendered');
    ok(body.includes('Alice Anderson'), 'DM chat row shows the peer name');
    ok(body.includes('Town Square'), 'public group listed');
    ok(body.includes('Work stuff'), 'custom Mattermost category exposed as a folder');
    ok(body.includes('Mia Meyer'), 'user panel shows the current user');

    // Wait for the channel posts request of the initial chat (fetch + render time varies).
    await waitFor(() => document.body.innerHTML.includes('How are you'));
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

    console.log('\n== view counts ==');
    // The plugin server component seeds two viewers on the deploy post; the UI must render the
    // tally and report the visible posts back through POST /plugins/.../api/v1/views.
    await waitFor(() => document.querySelector('.tgw-msg-views'));
    const viewsLabel = (document.querySelector('.tgw-msg-views')?.textContent || '').trim();
    ok(/[1-9]/.test(viewsLabel), `view count rendered next to the message (${viewsLabel})`);
    ok(document.querySelector('.tgw-msg-views svg'), 'view count shows the eye icon');
    const p3row = Array.from(document.querySelectorAll('.tgw-msg-in')).find((row) => row.getAttribute('data-post-id') === 'p3');
    const p3views = (p3row?.querySelector('.tgw-msg-views')?.textContent || '').trim();
    ok(p3views === '2', `own view is excluded from the count (p3 shows ${p3views || 'nothing'})`);
    // Checkmark receipts: p2 (mine) was seen by another user, so it must show two checks;
    // a fresh outgoing post nobody else saw keeps a single check (asserted in the reply section).
    await waitFor(() => {
        const p2 = Array.from(document.querySelectorAll('.tgw-msg-out')).find((row) => row.getAttribute('data-post-id') === 'p2');
        return p2?.querySelector('.tgw-msg-status svg path[d^="M19.6"]');
    });
    const p2row = Array.from(document.querySelectorAll('.tgw-msg-out')).find((row) => row.getAttribute('data-post-id') === 'p2');
    ok(!!p2row?.querySelector('.tgw-msg-status svg path[d^="M19.6"]'), 'message seen by someone else shows two checkmarks');
    await waitFor(() => calls.some((call) => call.startsWith('POST /plugins/com.telegramweb.ui/api/v1/views')), 3000);
    ok(calls.some((call) => call.startsWith('POST /plugins/com.telegramweb.ui/api/v1/views')), 'visible posts reported as seen to the plugin API');
    ok(calls.some((call) => call.startsWith('GET /plugins/com.telegramweb.ui/api/v1/views')), 'view counts fetched from the plugin API');

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
            const replyRow = Array.from(document.querySelectorAll('.tgw-msg-out')).pop();
            ok(!!replyRow?.querySelector('.tgw-msg-status svg path[d^="M9.6"]'), 'reply nobody else saw shows a single checkmark');
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

    // Telegram-style speed control: 1x → 1.5x → 2x → wrap.
    const speedButton = document.querySelector('.tgw-voice-speed');
    ok(!!speedButton, 'playback speed control rendered');
    if (speedButton) {
        const cycle = async (label) => {
            document.querySelector('.tgw-voice-speed').dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
            await tick(20);
            ok(document.querySelector('.tgw-voice-speed')?.textContent.trim() === label, `speed cycles to ${label}`);
        };
        await cycle('1.5x');
        await cycle('2x');
        await cycle('1x');
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
            ok(!document.querySelector('.tgw-attachment-video'), 'server-classified video/webm voice take still uses the voice player, not the video player');
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
        ok(dom.window.__historyPushes.includes('/demo/channels/town-square'), 'opening a chat pushes its Mattermost URL');
        ok(document.activeElement === document.querySelector('.tgw-composer textarea'), 'composer input focused after switching chats');

        // Info panel members must come from the REST list, not the sparse host Redux copy.
        document.querySelector('.tgw-chat-header-main')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-members'));
        const memberNames = Array.from(document.querySelectorAll('.tgw-member-name')).map((node) => node.textContent);
        ok(memberNames.includes('Nina Novak'), 'member list shows people the host store never loaded');
        ok(memberNames.length === 3, `member list renders every member (${memberNames.length})`);
        ok(document.body.innerHTML.includes('3 members'), 'member count label matches the list');
        document.querySelector('.tgw-info-header .tgw-icon-button')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await tick(30);
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

        // Up arrow in an empty composer opens my last message for editing (Mattermost shortcut).
        textarea.value = '';
        textarea.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(30);
        textarea.style.height = '';
        textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'ArrowUp', bubbles: true, cancelable: true}));
        await tick(60);
        ok(!!document.querySelector('.tgw-edit-bar'), 'ArrowUp on an empty composer opens the edit bar');
        const editArea = document.querySelector('.tgw-composer textarea');
        ok(!!editArea && editArea.value.includes('hello from the smoke test'), `edit box loaded with the last own message (${editArea && editArea.value})`);
        // Regression: loading a (large) message for editing must re-measure the box height;
        // previously only typing did, so long edits stayed stuck at one line.
        ok(editArea && editArea.style.height === '24px', `composer height re-applied when the edit message loaded (${editArea && editArea.style.height})`);
        if (editArea) {
            editArea.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
            await tick(30);
            ok(!document.querySelector('.tgw-edit-bar'), 'Escape cancels the edit');
        }
    }

    // The box must *grow* for a long message, not just get re-measured. jsdom does no layout
    // (scrollHeight is always 0), so give the textarea a content-based scrollHeight for this
    // check and assert the height the composer applies actually rises past one line.
    const ownTextarea = document.querySelector('.tgw-composer textarea');
    ok(!!ownTextarea, 'composer available for the long-edit check');
    if (ownTextarea) {
        const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
        const longEditText = 'Preparing the release checklist: deployments, rollbacks, feature flags, canaries, dashboards, '
            + 'on-call rotations and the runbook all have to be linked from this message so reviewers find everything. '
            + 'Telemetry additions, migration notes, rollout steps and the customer communication draft are listed below.';
        valueSetter.call(ownTextarea, longEditText);
        ownTextarea.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(30);
        document.querySelector('.tgw-send-button').dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await tick(80);
        ok(document.body.innerHTML.includes('release checklist'), 'long message sent');
        valueSetter.call(ownTextarea, '');
        ownTextarea.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(30);

        // Approximate a browser: ~60 chars per line, ~20px line height, plus padding.
        Object.defineProperty(dom.window.HTMLTextAreaElement.prototype, 'scrollHeight', {
            configurable: true,
            get() {
                if (!this.value) {
                    return 0;
                }
                return Math.max(24, Math.ceil(this.value.length / 60) * 20 + 14);
            },
        });
        ownTextarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'ArrowUp', bubbles: true, cancelable: true}));
        await tick(60);
        const longEditArea = document.querySelector('.tgw-composer textarea');
        const appliedHeight = longEditArea ? parseInt(longEditArea.style.height, 10) : 0;
        ok(!!longEditArea && longEditArea.value.includes('release checklist'), 'the long message loaded for editing');
        ok(appliedHeight >= 100, `the edit box grew past one line for a long message (style height: ${longEditArea && longEditArea.style.height})`);
        if (longEditArea) {
            longEditArea.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
            await tick(30);
        }
        delete dom.window.HTMLTextAreaElement.prototype.scrollHeight;
    }

    console.log('\n== favorites API ==');
    // The star used to go through window.WebappUtils — a host helper plugins are not guaranteed
    // to see — so "remove from favorites" silently called nothing. Seed Town Square as a
    // favorite the way Mattermost stores it (a preference) and remove it from the context menu.
    // Replace the preferences object (not just a key inside it): the selectors memoize on its
    // identity, so an in-place mutation would never surface in the rendered rows.
    state.entities.preferences = {
        myPreferences: {
            ...state.entities.preferences.myPreferences,
            [`favorite_channel--${ids.TOWN}`]: {category: 'favorite_channel', name: ids.TOWN, user_id: ids.ME, value: 'true'},
        },
    };
    notifyStoreChange();
    await waitFor(() => document.querySelector('.tgw-chat-row-star'));
    ok(!!document.querySelector('.tgw-chat-row-star'), 'seeding the favorite preference lights up the star on the row');
    const favRow = Array.from(document.querySelectorAll('.tgw-chat-row')).find((row) => row.textContent.includes('Town Square'));
    ok(!!favRow, 'town square row found for the favorites check');
    if (favRow) {
        favRow.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, clientX: 60, clientY: 60}));
        await waitFor(() => document.querySelector('.tgw-menu'));
        const removeEntry = Array.from(document.querySelectorAll('.tgw-menu-item')).find((el) => el.textContent.includes('Remove from favorites'));
        ok(!!removeEntry, 'context menu offers removing the chat from favorites');
        const prefCallsBefore = calls.length;
        removeEntry?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => calls.slice(prefCallsBefore).some((call) => call === 'PUT /users/me/preferences'), 3000);
        ok(calls.slice(prefCallsBefore).some((call) => call === 'PUT /users/me/preferences'), 'removing a favorite is sent to the preferences API');
        const prefPayload = payloads.filter((entry) => entry.path === '/users/me/preferences').pop();
        const prefEntry = prefPayload && prefPayload.body && prefPayload.body[0];
        ok(!!prefEntry && prefEntry.category === 'favorite_channel' && prefEntry.name === ids.TOWN && prefEntry.value === 'false', `favorite preference cleared with value false (got: ${JSON.stringify(prefPayload && prefPayload.body)})`);
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        await waitFor(() => !document.querySelector('.tgw-menu'));
    }

    console.log('\n== drag to reorder ==');
    // Category tabs reorder their chats by dragging, through Mattermost's own sidebar-category
    // endpoint (PUT /users/{user_id}/teams/{team_id}/channels/categories).
    const workTab = Array.from(document.querySelectorAll('.tgw-folder')).find((button) => button.textContent.includes('Work stuff'));
    ok(!!workTab, 'folder tab rendered for the reorder check');
    if (workTab) {
        workTab.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelectorAll('.tgw-chat-row').length >= 2);
        const rowsNow = Array.from(document.querySelectorAll('.tgw-chat-row'));
        ok(rowsNow.length >= 2, `the category tab shows its chats (${rowsNow.length})`);
        ok(rowsNow.some((row) => row.textContent.includes('Town Square')) && rowsNow.some((row) => row.textContent.includes('Alice Anderson')), 'both chats of the category render');
        const callsBeforeDrag = calls.length;
        rowsNow[0].dispatchEvent(new dom.window.Event('dragstart', {bubbles: true, cancelable: true}));
        await tick(40);
        rowsNow[1].dispatchEvent(new dom.window.Event('dragover', {bubbles: true, cancelable: true}));
        await tick(40);
        rowsNow[1].dispatchEvent(new dom.window.Event('drop', {bubbles: true, cancelable: true}));
        await waitFor(() => calls.slice(callsBeforeDrag).some((call) => /^PUT \/users\/[^/]+\/teams\/[^/]+\/channels\/categories$/.test(call)), 3000);
        ok(calls.slice(callsBeforeDrag).some((call) => /^PUT \/users\/[^/]+\/teams\/[^/]+\/channels\/categories$/.test(call)), 'drag sends the new order to Mattermost\u2019s sidebar-category endpoint');
        const catPayload = payloads.filter((entry) => /\/channels\/categories$/.test(entry.path)).pop();
        const savedCategory = catPayload && Array.isArray(catPayload.body) && catPayload.body[0];
        ok(!!savedCategory && savedCategory.sorting === 'manual', `drag switches the category to manual sorting (got: ${JSON.stringify(savedCategory && savedCategory.sorting)})`);
        const expectedOrder = `${ids.DM},${ids.TOWN}`;
        ok(!!savedCategory && (savedCategory.channel_ids || []).join(',') === expectedOrder, `the dragged chat lands after the target (got: ${JSON.stringify(savedCategory && savedCategory.channel_ids)})`);
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

        // Wide all-messages search: Enter in the search box opens the full results panel.
        valueSetter.call(searchInput, 'Deploy');
        searchInput.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        // While the message search is still on its way (debounce + round trip) the panel must
        // show a searching state, not a premature "Nothing found".
        await tick(60);
        ok(document.body.innerHTML.includes('Searching'), 'sidebar shows a searching state while the message search runs');
        ok(!document.body.innerHTML.includes('Nothing found'), 'no "Nothing found" flash while the search is still running');
        await waitFor(() => document.body.innerHTML.includes('See all message results'), 3000);
        ok(document.body.innerHTML.includes('See all message results'), 'see-all link rendered for message matches');
        const searchCallsBefore = calls.length;
        searchInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
        await waitFor(() => !!document.querySelector('.tgw-search-panel'), 3000);
        ok(!!document.querySelector('.tgw-search-panel'), 'Enter opens the wide search panel');
        await waitFor(() => calls.slice(searchCallsBefore).some((call) => call === 'POST /posts/search'), 3000);
        ok(calls.slice(searchCallsBefore).some((call) => call === 'POST /posts/search'), 'wide panel fetches all-messages results');
        await waitFor(() => !!document.querySelector('.tgw-search-hit'), 3000);
        const hit = document.querySelector('.tgw-search-hit');
        ok(!!hit, 'wide search renders a message hit');
        ok(!!hit && hit.querySelector('.tgw-search-mark') !== null, 'hit highlights the matched term');
        ok(!!hit && hit.textContent.includes('Alice Anderson'), 'hit shows the owning channel title');
        if (hit) {
            hit.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
            await waitFor(() => document.querySelector('.tgw-chat-header-title')?.textContent === 'Alice Anderson', 3000);
            ok(!document.querySelector('.tgw-search-panel'), 'clicking a hit closes the wide panel');
            await waitFor(() => !!document.querySelector('.tgw-post-highlight'), 3000);
            ok(!!document.querySelector('.tgw-post-highlight'), 'clicking a hit opens the chat at the matched message');
        }

        // A hit older than the first loaded page (p-old) exists only through search: clicking it
        // must fetch it on demand so the chat lands on the message instead of just opening.
        valueSetter.call(searchInput, 'deploy');
        searchInput.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await waitFor(() => document.body.innerHTML.includes('pipeline'), 3000);
        const oldHit = Array.from(document.querySelectorAll('.tgw-message-hit')).find((row) => row.textContent.includes('pipeline'));
        ok(!!oldHit, 'the off-screen message shows up as a sidebar search hit');
        const callsBeforeHit = calls.length;
        if (oldHit) {
            oldHit.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
            await waitFor(() => calls.slice(callsBeforeHit).some((call) => call === 'GET /posts/p-old'), 3000);
            ok(calls.slice(callsBeforeHit).some((call) => call === 'GET /posts/p-old'), 'the off-screen hit is fetched on demand');
            await waitFor(() => {
                const row = document.querySelector('[data-post-id="p-old"]');
                return !!row && row.classList.contains('tgw-post-highlight');
            }, 3000);
            const landedRow = document.querySelector('[data-post-id="p-old"]');
            ok(!!landedRow, 'the hit message renders in the chat');
            ok(!!landedRow && landedRow.classList.contains('tgw-post-highlight'), 'the chat lands on the hit message with the flash highlight');
        }
    } else {
        fail('search input missing');
    }

    console.log('\n== settings ==');
    ok(getSettings().mode === 'on', 'plugin settings loaded (server default applied)');

    ok(getSettings().glassyMode === true, 'glassy panels default to on');
    updateSettings({accent: 'violet', compactMode: true, theme: 'dark'});
    await tick(60);
    const rootEl = document.querySelector('.tgw-root');
    ok(!!rootEl && rootEl.classList.contains('tgw-accent-violet'), 'accent setting is applied to the root element');
    ok(!!rootEl && rootEl.classList.contains('tgw-compact'), 'compact mode is applied to the root element');
    ok(!!rootEl && rootEl.classList.contains('tgw-theme-dark'), 'theme setting is applied to the root element');
    ok(!!rootEl && rootEl.classList.contains('tgw-glassy'), 'glassy panels are on by default');
    updateSettings({glassyMode: false});
    await tick(60);
    ok(!!rootEl && !rootEl.classList.contains('tgw-glassy'), 'glassy mode can be switched off');
    ok(getSettings().wallpaper === 'doodles', 'the doodle chat wallpaper is on by default');
    updateSettings({wallpaper: 'checker'});
    await tick(60);
    ok(!!rootEl && rootEl.classList.contains('tgw-wallpaper-checker'), 'the wallpaper setting is applied to the root element');
    updateSettings({wallpaper: 'doodles'});
    await tick(60);
    updateSettings({glassyMode: true, theme: 'midnight'});
    await tick(60);
    ok(!!rootEl && rootEl.classList.contains('tgw-theme-midnight'), 'the extra midnight theme applies its own palette class');
    updateSettings({theme: 'dark'});
    await tick(60);

    console.log('\n== url sync ==');
    // Leave search mode first so the normal chat list is back.
    document.querySelector('.tgw-search-clear')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await tick(30);
    const dmRow = Array.from(document.querySelectorAll('.tgw-chat-row')).find((row) => row.textContent.includes('Alice Anderson'));
    ok(!!dmRow, 'dm row found for the url sync check');
    if (dmRow) {
        dmRow.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-chat-header-title')?.textContent === 'Alice Anderson');
        ok(dom.window.__historyPushes.includes('/demo/messages/@alice'), 'switching chats pushes the new URL');
    }

    console.log('\n== inline code copy ==');
    let copiedText = null;
    Object.defineProperty(dom.window.navigator, 'clipboard', {
        value: {writeText: (text) => { copiedText = text; return Promise.resolve(); }},
        configurable: true,
    });
    handleSocketEvent('posted', {event: 'posted', data: {post: JSON.stringify({
        id: 'p-inline-code', create_at: Date.now(), update_at: Date.now(), edit_at: 0, delete_at: 0,
        user_id: posts.p1.user_id, channel_id: ids.DM, message: 'run `make test` before pushing',
        type: '', props: {}, root_id: '', metadata: {},
    })}});
    await waitFor(() => document.querySelector('.tgw-inline-code'));
    const inlineCode = document.querySelector('.tgw-inline-code');
    ok(!!inlineCode && inlineCode.textContent === 'make test', 'inline code renders in the message body');
    if (inlineCode) {
        inlineCode.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await tick(60);
        ok(copiedText === 'make test', 'clicking inline code copies its text to the clipboard');
        ok(inlineCode.classList.contains('tgw-code-copied'), 'the copied snippet flashes the feedback class');
        ok((document.querySelector('.tgw-toasts')?.textContent || '').includes('Code copied'), 'a toast confirms the copy');
    }

    console.log('\n== stock UI view tracking ==');
    // A user on the stock Mattermost UI never scrolls our message list: opening a channel there
    // must still report its recent posts as seen through the plugin API. Turn the overlay off
    // and poke the host store the way a channel switch in the stock sidebar would.
    updateSettings({mode: 'off'});
    const stockCallsBefore = calls.length;
    startStockUIViewTracking();
    notifyStoreChange();
    await waitFor(() => calls.slice(stockCallsBefore).some((call) => call === `GET /channels/${ids.DM}/posts`), 3000);
    ok(calls.slice(stockCallsBefore).some((call) => call === `GET /channels/${ids.DM}/posts`), 'opening a channel in the stock UI fetches its recent posts');

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
