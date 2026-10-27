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
    store, state, posts, ids, tick, ok, fail, report, notifyStoreChange, holdPosts, viewTracking,
    pushStockPost,
} = require('./harness');

// --------------------------------------------------------------------------- mount
const {setStore} = require('../src/mm/store');
const {initSettings, updateSettings, getSettings} = require('../src/mm/settings');
const {handleSocketEvent} = require('../src/mm/socket');
const {api} = require('../src/mm/api');
const {searchChats} = require('../src/mm/selectors');
const {startStockUIViewTracking} = require('../src/mm/stock-views');
const {ensureViewStats, getViewStats} = require('../src/mm/views');
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
    ok(searchChats(state, 'Direct').every((chat) => chat.title !== 'Direct message'),
        'searching Direct does not return DMs with the generic fallback title');

    // Each folder tab carries its unread message total. All sums everything (DM 4-2=2 + Town
    // Square 12-1=11 = 13); Unread lists only conversations that have unread messages.
    const folderBtn = (label) => Array.from(document.querySelectorAll('.tgw-folder'))
        .find((btn) => (btn.textContent || '').startsWith(label));
    const folderCount = (label) => {
        const badge = folderBtn(label)?.querySelector('.tgw-folder-badge');
        return badge ? badge.textContent : '';
    };
    console.log('== folder unread counters ==');
    ok(!!folderBtn('All'), 'folder tabs rendered with counters');
    ok(folderCount('All') === '13', `the All tab carries the total unread message count (${folderCount('All') || 'none'})`);
    ok(folderCount('Unread') === '13', `the Unread tab counts unread messages across conversations (${folderCount('Unread') || 'none'})`);
    ok(folderCount('Groups') === '11', `the Groups tab counts only its channel (${folderCount('Groups') || 'none'})`);
    ok(folderCount('Direct Messages') === '2', `the Direct Messages tab counts the DM (${folderCount('Direct Messages') || 'none'})`);
    ok(folderCount('Work stuff') === '13', `a custom folder sums its chats (${folderCount('Work stuff') || 'none'})`);
    ok(!folderBtn('Contacts')?.querySelector('.tgw-folder-badge'), 'tabs without unread chats carry no badge');

    // Unread shows only unread conversations, prioritizing unmuted personal/mentioned chats.
    console.log('== unread folder ordering ==');
    const clickFolder = (label) => folderBtn(label)?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    clickFolder('Unread');
    await waitFor(() => (folderBtn('Unread')?.className || '').includes('tgw-folder-active'));
    const unreadRowTexts = () => Array.from(document.querySelectorAll('.tgw-chat-row')).map((row) => row.textContent || '');
    ok(unreadRowTexts().some((text) => text.includes('Alice Anderson')), 'a direct message is displayed in the Unread folder');
    ok(unreadRowTexts().some((text) => text.includes('Town Square')), 'a channel that mentions you is displayed in the Unread folder');
    ok(unreadRowTexts().length === 2, 'the Unread folder omits read chats');
    const unreadPreviewRow = Array.from(document.querySelectorAll('.tgw-chat-row')).find((row) => row.textContent.includes('Alice Anderson'));
    unreadPreviewRow?.dispatchEvent(new dom.window.MouseEvent('mouseover', {bubbles: true}));
    await waitFor(() => !!document.querySelector('.tgw-unread-peek'), 3000);
    await waitFor(() => !document.querySelector('.tgw-unread-peek-empty')?.textContent.includes('Loading'));
    ok((document.querySelector('.tgw-unread-peek')?.textContent || '').includes('Deploy'), 'hovering an unread chat previews recent unread messages');
    unreadPreviewRow?.dispatchEvent(new dom.window.MouseEvent('mouseout', {bubbles: true}));
    // Take Town Square's mention away: its unread messages still qualify it for this folder.
    const originalMembers = state.entities.channels.myMembers;
    state.entities.channels.myMembers = {...originalMembers, [ids.TOWN]: {...originalMembers[ids.TOWN], mention_count: 0}};
    notifyStoreChange();
    await waitFor(() => folderCount('Unread') === '13');
    ok(folderCount('Unread') === '13', `a non-tagged unread channel still contributes unread messages (${folderCount('Unread') || 'none'})`);
    ok(unreadRowTexts().some((text) => text.includes('Town Square')), 'a non-tagged chat with unread messages stays in the Unread folder');
    state.entities.channels.myMembers = originalMembers;
    notifyStoreChange();
    await waitFor(() => folderCount('Unread') === '3');
    ok(folderCount('All') === '13', `the All tab still totals every unread message (${folderCount('All') || 'none'})`);
    clickFolder('All');
    await waitFor(() => (folderBtn('All')?.className || '').includes('tgw-folder-active'));

    // The category tabs drag to reorder, and the order persists exactly like other settings:
    // the settings user preference plus a localStorage mirror. All/Unread stay pinned at the
    // front, Contacts at the end.
    console.log('== folder tab reordering ==');
    const folderLabels = () => Array.from(document.querySelectorAll('.tgw-folder'))
        .map((btn) => (btn.textContent || '').replace(/\d+\+?$/, '').trim());
    const defaultTabOrder = folderLabels().join(',');
    const folderStarting = (label) => Array.from(document.querySelectorAll('.tgw-folder'))
        .find((btn) => (btn.textContent || '').startsWith(label));
    const workTabBtn = folderStarting('Work stuff');
    const groupsTabBtn = folderStarting('Groups');
    ok(!!workTabBtn && !!groupsTabBtn, 'both category tabs render for the tab reorder check');
    if (workTabBtn && groupsTabBtn) {
        workTabBtn.dispatchEvent(new dom.window.Event('dragstart', {bubbles: true, cancelable: true}));
        await tick(30);
        ok(workTabBtn.classList.contains('tgw-folder-dragging'), 'the dragged folder shows its dragging state');
        groupsTabBtn.dispatchEvent(new dom.window.Event('dragover', {bubbles: true, cancelable: true}));
        await tick(30);
        ok(groupsTabBtn.classList.contains('tgw-folder-dragover'), 'the drop target folder highlights');
        groupsTabBtn.dispatchEvent(new dom.window.Event('drop', {bubbles: true, cancelable: true}));
        const expectedTabOrder = 'All,Unread,Work stuff,Groups,Direct Messages,Contacts';
        await waitFor(() => folderLabels().join(',') === expectedTabOrder);
        const reordered = folderLabels().join(',');
        ok(reordered === expectedTabOrder,
            `the dropped category lands before its target, with All/Unread/Contacts pinned (${reordered})`);

        const persistedTabOrder = () => {
            const candidates = payloads.filter((entry) => entry.path === '/users/me/preferences'
                && Array.isArray(entry.body) && entry.body[0] && entry.body[0].name === 'settings');
            for (let index = candidates.length - 1; index >= 0; index--) {
                let parsed = null;
                try {
                    parsed = JSON.parse(candidates[index].body[0].value);
                } catch (err) {
                    parsed = null;
                }
                // Skip the startup write, which still carries the default (empty) order.
                if (parsed && Array.isArray(parsed.tabOrder) && parsed.tabOrder.length > 0) {
                    return parsed.tabOrder;
                }
            }
            return null;
        };
        await waitFor(() => !!persistedTabOrder(), 3000);
        const savedOrder = persistedTabOrder();
        ok(Array.isArray(savedOrder) && savedOrder.join(',') === 'cat-work,cat-ch,cat-dm',
            `the folder order is saved in the settings user preference (${savedOrder ? savedOrder.join(',') : 'none'})`);
        const localMirror = JSON.parse(dom.window.localStorage.getItem('tgw.settings.com.telegramweb.ui') || '{}');
        ok(Array.isArray(localMirror.tabOrder) && localMirror.tabOrder.join(',') === 'cat-work,cat-ch,cat-dm',
            'the folder order is mirrored in localStorage');

        // Back to the default order for the rest of the suite.
        updateSettings({tabOrder: []});
        await waitFor(() => folderLabels().join(',') === defaultTabOrder);
        ok(folderLabels().join(',') === defaultTabOrder, 'clearing the saved order restores the default tab order');
    }

    // One status dot per avatar, overlaying the circle; an online peer must not gain a second,
    // row-level dot next to the avatar's own badge.
    console.log('== status dots ==');
    const dotRow = () => Array.from(document.querySelectorAll('.tgw-chat-row')).find((row) => row.textContent.includes('Alice'));
    ok(!!dotRow() && dotRow().querySelectorAll('.tgw-status-dot').length === 1, 'the chat row shows exactly one avatar status dot');
    ok(!document.querySelector('.tgw-chat-row-online-dot'), 'the duplicate row-level online dot is gone');
    state.entities.users.statuses[ids.OTHER] = 'online';
    notifyStoreChange();
    await waitFor(() => !!document.querySelector('.tgw-chat-row .tgw-status-online'));
    const onlineDots = dotRow() ? dotRow().querySelectorAll('.tgw-status-dot, .tgw-chat-row-online-dot').length : 0;
    ok(onlineDots === 1, `an online peer renders a single green dot (${onlineDots})`);
    state.entities.users.statuses[ids.OTHER] = 'away';
    notifyStoreChange();
    await tick(40);

    // Wait for the channel posts request of the initial chat (fetch + render time varies).
    await waitFor(() => document.body.innerHTML.includes('How are you'));
    console.log('\n== messages ==');
    ok(document.body.innerHTML.includes('How are you'), 'loaded messages rendered');
    ok(document.body.innerHTML.includes('Deploy'), 'second message rendered');
    ok(document.body.innerHTML.includes('https://example.com/run'), 'links rendered');
    const clickedMessageLink = document.querySelector('.tgw-message-text a[href="https://example.com/run"]');
    let clickedURLCopy = null;
    Object.defineProperty(dom.window.navigator, 'clipboard', {
        configurable: true,
        value: {writeText: (text) => { clickedURLCopy = text; return Promise.resolve(); }},
    });
    const linkClick = new dom.window.MouseEvent('click', {bubbles: true, cancelable: true});
    clickedMessageLink?.dispatchEvent(linkClick);
    await tick(30);
    ok(!linkClick.defaultPrevented, 'clicking a message URL keeps normal link behavior');
    ok(clickedURLCopy === null, 'clicking a message URL does not copy it');
    ok(document.querySelector('.tgw-messages').innerHTML.includes('😄') || document.body.innerHTML.includes(':smile:'), 'emoji shortcode rendered');
    ok(calls.some((call) => call.includes('/channels/channel-dm/posts')), 'messages were fetched through the REST API');
    ok(calls.some((call) => call.includes('/channels/members/user-me/view')), 'channel marked as read');
    ok(!!document.querySelector('.tgw-reaction'), 'reactions rendered');
    ok(!!document.querySelector('.tgw-bubble > .tgw-reactions') && !document.querySelector('.tgw-msg-meta .tgw-reactions'), 'reaction chips sit on the left side of the bubble');
    const firstStamp = document.querySelector('.tgw-msg-time')?.textContent || '';
    // The shipped admin default (plugin.json → DefaultJalali: true) turns the Jalali calendar on,
    // so the fixture date (mid-November 2023) renders as its Jalali day in Aban 1402.
    ok(/\bAba\b/.test(firstStamp) && /1402/.test(firstStamp), `messages from another day show their date beside the time (${firstStamp})`);
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
    // Direct chats hide the tally — the receipt below carries the same information — even when
    // the data is there: p3 has two seeded viewers, which would render an eye without the DM
    // gate (group chats assert the positive case in the interactions section).
    ok(!document.querySelector('.tgw-msg-views'), 'direct message bubbles do not show the view tally');
    // The tracking itself keeps running: visible posts are reported through POST
    // /plugins/.../api/v1/views and their counts fetched back with GET.
    // Checkmark receipts: p2 (mine) was seen by another user, so it must show two checks;
    // a fresh outgoing post nobody else saw keeps a single check (asserted in the reply section).
    await waitFor(() => {
        const p2 = Array.from(document.querySelectorAll('.tgw-msg-out')).find((row) => row.getAttribute('data-post-id') === 'p2');
        return p2?.querySelector('.tgw-msg-status svg path[d^="M4 12.5"]');
    });
    const p2row = Array.from(document.querySelectorAll('.tgw-msg-out')).find((row) => row.getAttribute('data-post-id') === 'p2');
    ok(!!p2row?.querySelector('.tgw-msg-status svg path[d^="M4 11.9"]'), 'message seen by someone else shows two checkmarks');
    await waitFor(() => calls.some((call) => call.startsWith('POST /plugins/com.telegramweb.ui/api/v1/views')), 3000);
    ok(calls.some((call) => call.startsWith('POST /plugins/com.telegramweb.ui/api/v1/views')), 'visible posts reported as seen to the plugin API');
    ok(calls.some((call) => call.startsWith('GET /plugins/com.telegramweb.ui/api/v1/views')), 'view counts fetched from the plugin API');

    console.log('\n== view stats batch limit ==');
    {
        const batchIds = Array.from({length: 125}, (_, index) => `batch-view-${index}`);
        batchIds.forEach((id) => viewTracking.set(id, new Set([ids.ME, ids.OTHER])));
        const start = calls.length;
        ensureViewStats(batchIds);
        await waitFor(() => getViewStats(batchIds[124])?.count === 2, 3000);
        const requests = calls.slice(start).filter((call) => call.startsWith('GET /plugins/com.telegramweb.ui/api/v1/views'));
        ok(requests.length >= 2, `view stats fetch drains batches beyond the server limit (${requests.length} requests)`);
        ok(getViewStats(batchIds[124])?.count === 2, 'the final post in the oversized batch receives its view status');
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
            const replyRow = Array.from(document.querySelectorAll('.tgw-msg-out')).pop();
            ok(!!replyRow?.querySelector('.tgw-msg-status svg path[d^="M9.6"]'), 'reply nobody else saw shows a single checkmark');
            ok(document.body.innerHTML.includes('this is a threaded reply'), 'threaded reply message rendered');
            ok(!document.querySelector('.tgw-reply-bar'), 'reply bar closes after the reply was sent');
        } else {
            fail('composer textarea missing while replying');
        }
    }

    // Read receipts must follow a live peer: while the other side is online the view stats are
    // re-polled about once a second, so their first look flips the single check to two checks.
    console.log('\n== live seen updates ==');
    const freshOut = Array.from(document.querySelectorAll('.tgw-msg-out')).pop();
    const freshId = freshOut?.getAttribute('data-post-id') || '';
    ok(!!freshId && !!document.querySelector(`[data-post-id="${freshId}"] .tgw-msg-status svg path[d^="M9.6"]`), 'the fresh outgoing post starts with a single checkmark');
    const viewsGets = () => calls.filter((call) => call.startsWith('GET /plugins/com.telegramweb.ui/api/v1/views')).length;

    // One of my messages is still unseen by the peer — that is the condition for refreshing:
    // about every second, so the receipt flips without a reload once they open it.
    const unseenGets = viewsGets();
    await tick(1400);
    ok(viewsGets() > unseenGets, `view stats re-poll about every second while a message is still unseen (${unseenGets} → ${viewsGets()} fetches)`);

    // The peer opens the message between two polls: the next fetch must flip the receipt.
    viewTracking.set(freshId, new Set([ids.ME, ids.OTHER]));
    await waitFor(() => document.querySelector(`[data-post-id="${freshId}"] .tgw-msg-status svg path[d^="M4 12.5"]`), 4000);
    ok(!!document.querySelector(`[data-post-id="${freshId}"] .tgw-msg-status svg path[d^="M4 11.9"]`), 'the receipt flips to two checkmarks once the peer sees the message');

    // Every message of mine has now been seen: with nothing left pending the polling stops
    // and waits for the next message to be sent.
    await tick(400); // let any in-flight poll land before counting
    const settledGets = viewsGets();
    await tick(1500);
    ok(viewsGets() === settledGets, 'polling stops once every message has been seen — it waits for the next message to be sent');

    console.log('\n== composer frees the input on send ==');
    // Regression: the composer used to reset() only after the network round trip, so chars
    // typed into the box while the send was in flight were wiped by the late cleanup.
    {
        const release = holdPosts();
        const area = document.querySelector('.tgw-composer textarea');
        const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
        valueSetter.call(area, 'first message');
        area.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(30);
        document.querySelector('.tgw-send-button').dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        // Give React a chance to flush the send handler; the request is still held by the gate.
        await tick(50);
        ok(area.value === '', 'input clears immediately, before the network round trip finishes');
        valueSetter.call(area, 'chars typed while sending');
        area.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(30);
        release();
        await waitFor(() => document.body.innerHTML.includes('first message'));
        ok(document.body.innerHTML.includes('first message'), 'the held message still went out');
        ok(area.value === 'chars typed while sending', 'text typed mid-send survives the cleanup');
        // Clear the box so later sections start from a clean composer.
        valueSetter.call(area, '');
        area.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(30);
    }

    console.log('\n== rtl / ltr direction ==');
    {
        const {directionOf} = require('../src/mm/utils');
        ok(directionOf('سلام دنیا') === 'rtl', 'Persian text is detected as RTL');
        ok(directionOf('hello') === 'ltr', 'Latin text is detected as LTR');
        ok(directionOf('سلام 123') === 'rtl', 'digits do not flip the direction of RTL text');
        ok(directionOf('123') === 'ltr', 'digits alone stay LTR');
        ok(directionOf('👍 great') === 'ltr', 'emoji before a Latin word stays LTR');

        const area = document.querySelector('.tgw-composer textarea');
        const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
        valueSetter.call(area, 'سلام دنیا');
        area.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(30);
        ok(area.getAttribute('dir') === 'rtl', 'composer flips to RTL for Persian input');
        valueSetter.call(area, 'hello');
        area.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(30);
        ok(area.getAttribute('dir') === 'ltr', 'composer flips back to LTR for Latin input');
        valueSetter.call(area, '');
        area.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(30);
        const messageBody = document.querySelector('.tgw-message-text');
        ok(!!messageBody && !messageBody.hasAttribute('dir'), 'message bodies leave direction to per-paragraph bidi layout');
    }

    console.log('\n== display names ==');
    {
        // Everywhere a person is labelled (chat rows, message headers, member lists, search
        // results) the real name leads and the nickname is kept visible in parentheses.
        const {displayName} = require('../src/mm/utils');
        ok(displayName({first_name: 'Ada', last_name: 'Lovelace', nickname: 'ada'}) === 'Ada Lovelace (ada)', 'full name shown with the nickname in parentheses');
        ok(displayName({first_name: 'Ada', last_name: 'Lovelace'}) === 'Ada Lovelace', 'a profile without a nickname keeps the plain full name');
        ok(displayName({first_name: 'Ada', last_name: 'Lovelace', nickname: 'Ada Lovelace'}) === 'Ada Lovelace', 'a nickname repeating the name alone is not duplicated');
        ok(displayName({first_name: '', last_name: '', nickname: 'ada'}) === 'ada', 'no real name falls back to the nickname');
        ok(displayName({username: 'ghost'}) === 'ghost', 'a profile with nothing else falls back to the username');
        // The rendered chat header carries Alice's nickname from the fixture.
        ok(document.querySelector('.tgw-chat-header-title')?.textContent === 'Alice Anderson (alley)', 'the DM header shows First Last (nickname)');
    }

    // Emoji must sit in one atomic, uniformly sized box inside messages: emoji fonts run taller
    // than the row (stretching it into "two lines") and sequences could break between lines.
    console.log('\n== emoji boxes in messages ==');
    const emojiBoxes = document.querySelectorAll('.tgw-message-text .tgw-emoji');
    ok(emojiBoxes.length > 0, `shortcode emoji wrapped in an atomic box (${emojiBoxes.length})`);
    ok(!!Array.from(emojiBoxes).find((box) => (box.textContent || '').includes('😄')), 'the smiley shortcode renders as a boxed emoji');
    {
        // The host formatter path has no PostUtils in jsdom: feed a synthetic element tree — the
        // same shape messageHtmlToComponent returns — through the wrapper instead.
        const {isolateLatinRuns, wrapEmojiNodes} = require('../src/ui/render');
        const hostTree = React.createElement('span', null,
            'سلام CI/CD اجرا میشن ', 'turn ', '⚙️ now ', '👨‍👩‍👧‍👦 ', React.createElement('code', null, ':gear: kept'));
        const probe = document.createElement('div');
        document.body.appendChild(probe);
        const probeRoot = ReactDOMClient.createRoot(probe);
        probeRoot.render(isolateLatinRuns(wrapEmojiNodes(hostTree)));
        await tick(40);
        const wrappedBoxes = probe.querySelectorAll('.tgw-emoji');
        ok(wrappedBoxes.length === 2, `host-path emoji wrapped into boxes (${wrappedBoxes.length})`);
        ok((wrappedBoxes[0]?.textContent || '') === '⚙️', `variation-selector emoji kept whole (${wrappedBoxes[0]?.textContent || ''})`);
        ok((wrappedBoxes[1]?.textContent || '') === '👨‍👩‍👧‍👦', 'ZWJ sequence stays inside one box');
        ok(probe.querySelector('code')?.textContent === ':gear: kept', 'code spans keep their raw text');
        const isolated = probe.querySelector('.tgw-bidi-ltr');
        ok(isolated?.tagName === 'BDI' && isolated.getAttribute('dir') === 'ltr' && isolated.textContent === 'CI/CD', 'Latin tokens with punctuation stay isolated inside Persian text');
        probeRoot.unmount();
        probe.remove();
    }

    // Typed without a scheme: google.com / openai.com must become links, emails must not.
    console.log('\n== bare domain links ==');
    {
        const {renderFallback} = require('../src/ui/render');
        const probe = document.createElement('div');
        document.body.appendChild(probe);
        const probeRoot = ReactDOMClient.createRoot(probe);
        probeRoot.render(React.createElement('span', null,
            renderFallback('go to google.com or openai.com now (see https://x.io/y) mail bob@WAY.com')));
        await tick(40);
        const links = Array.from(probe.querySelectorAll('a')).map((a) => `${a.textContent}→${a.getAttribute('href')}`);
        ok(links.includes('google.com→https://google.com'), `bare google.com linked without a scheme (${links.join(', ')})`);
        ok(links.includes('openai.com→https://openai.com'), 'bare openai.com linked');
        ok(links.includes('https://x.io/y→https://x.io/y'), 'an explicit https URL keeps working');
        ok(!links.includes('bob@WAY.com→https://WAY.com'), 'an email address is not linkified as a bare domain');
        ok(!probe.querySelectorAll('a').length || probe.textContent.includes('bob@WAY.com'), 'the address stays visible as text');
        probeRoot.unmount();
        probe.remove();
    }

    console.log('\n== emoji previews ==');
    document.querySelector('button[title="Emoji"]')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await waitFor(() => document.querySelector('.tgw-emoji-picker'));
    document.querySelector('.tgw-chat-header')?.dispatchEvent(new dom.window.MouseEvent('mousedown', {bubbles: true}));
    ok(!!(await waitFor(() => !document.querySelector('.tgw-emoji-picker'))), 'clicking outside closes the emoji picker');
    {
        // p2 contains ":smile:" — the chat-list preview and reply previews must show the
        // unicode emoji, not the raw shortcode. Start a reply on p2 to inspect its preview.
        const {toPlainPreview} = require('../src/mm/utils');
        ok(toPlainPreview('hi :smile: there').includes('😄'), 'toPlainPreview renders shortcodes as unicode emoji');
        ok(toPlainPreview('hi :unknown-emoji: there').includes(':unknown-emoji:'), 'unknown shortcodes pass through unchanged');
        // The markdown cleanup must strip emphasis pair-wise: a blanket `**|__|*|_` stripper ate
        // the underscore inside `:party_parrot:` and inside ordinary words like `snake_case`.
        ok(toPlainPreview('use snake_case names in commits').includes('snake_case'), 'underscores in plain text survive the markdown cleanup');
        ok(toPlainPreview('deploy done :party_parrot: dance').includes(':party_parrot:'), 'a custom emoji shortcode keeps its shape in preview text');
        ok(toPlainPreview('__bold__ and _italic_ markers').includes('bold and italic'), 'bold and italic markers are still stripped pairwise');
        // The full Mattermost system set resolves, not just the curated picker rows.
        const {EMOJI_CATEGORIES, emojiChar, replaceShortcodes, replaceUnsupportedMattermostShortcodes, searchEmoji} = require('../src/mm/emoji');
        const {EMOJI_SHORTCODES} = require('../src/mm/emoji-data');
        ok(replaceShortcodes('go :space_invader: go').includes('👾'), ':space_invader: expands to its emoji');
        ok(replaceShortcodes('go :technologist: go').includes('\u{1F9D1}\u200D\u{1F4BB}'), ':technologist: expands to its ZWJ sequence');
        ok(replaceShortcodes('go :hankey: go').includes('💩'), ':hankey: expands as well');
        ok(emojiChar('grinning_face_with_smiling_eyes') === '😄', 'the grinning face alias maps to the correct emoji');
        ok(replaceUnsupportedMattermostShortcodes('hi :grinning_face_with_smiling_eyes:') === 'hi 😄', 'unsupported legacy aliases expand before Mattermost formats a message');
        const unsupportedNative = Object.keys(EMOJI_SHORTCODES)
            .filter((name) => replaceUnsupportedMattermostShortcodes(`:${name}:`) !== `:${name}:`);
        ok(unsupportedNative.length === 0, `all ${Object.keys(EMOJI_SHORTCODES).length} Mattermost shortcodes remain for the host formatter (${unsupportedNative.length} changed)`);
        const invalidNative = Object.entries(EMOJI_SHORTCODES)
            .filter(([name, char]) => emojiChar(name) !== char || replaceShortcodes(`:${name}:`) !== char);
        ok(invalidNative.length === 0, `all ${Object.keys(EMOJI_SHORTCODES).length} Mattermost shortcodes map to their canonical emoji (${invalidNative.length} mismatches)`);
        const unnamed = EMOJI_CATEGORIES.flatMap((category) => category.emojis).filter((entry) => !entry.char || !emojiChar(entry.name));
        ok(unnamed.length === 0, `every picker row has a character and a matching shortcode (${unnamed.length} broken)`);
        ok(searchEmoji('space_invader').some((entry) => entry.name === 'space_invader'), 'picker search reaches emoji outside the curated categories');
        ok(searchEmoji('technologist').some((entry) => entry.name === 'technologist'), 'picker search finds :technologist:');
        const p2row = Array.from(document.querySelectorAll('.tgw-msg-out')).find((row) => row.getAttribute('data-post-id') === 'p2');
        const p2Reply = p2row?.querySelector('.tgw-msg-toolbar button[title="Reply"]');
        if (p2Reply) {
            p2Reply.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
            await tick(60);
            const preview = document.querySelector('.tgw-reply-bar-text')?.textContent || '';
            ok(preview.includes('😄'), `reply preview shows the unicode emoji (${preview})`);
            // Cancel the reply again.
            document.querySelector('.tgw-composer textarea')?.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
            await tick(30);
            ok(!document.querySelector('.tgw-reply-bar'), 'escape cancels the reply bar');
        }
    }

    console.log('\n== post menu reactors ==');
    {
        const p3row = Array.from(document.querySelectorAll('.tgw-msg-in')).find((row) => row.getAttribute('data-post-id') === 'p3');
        ok(!!p3row, 'p3 rendered for the reactor-menu check');
        if (p3row) {
            // A second emoji from someone else gives us two groups, which is what makes the
            // divider between them observable.
            handleSocketEvent('reaction_added', {event: 'reaction_added', data: {reaction: JSON.stringify({user_id: ids.OTHER, post_id: 'p3', emoji_name: 'muscle', create_at: Date.now()})}});
            await tick(30);
            p3row.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, clientX: 120, clientY: 200}));
            await waitFor(() => document.querySelector('.tgw-menu'));
            ok(!document.querySelector('.tgw-menu-submenu-row'), 'reactor details are kept out of the main context menu');
            const submenuTrigger = document.querySelector('.tgw-menu-submenu-trigger');
            ok(!!submenuTrigger && submenuTrigger.textContent.includes('Reactions'), 'the context menu has a Reactions submenu');
            submenuTrigger?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
            const panel = await waitFor(() => document.querySelector('.tgw-menu-submenu-panel'));
            const groupHeaders = Array.from(panel.querySelectorAll('.tgw-menu-submenu-heading'));
            ok(groupHeaders.length === 2, `the submenu shows two emoji groups (${groupHeaders.length})`);
            const tadaHeader = groupHeaders.find((item) => item.querySelector('.tgw-reaction-emoji')?.textContent?.includes('🎉'));
            ok(!!tadaHeader, 'the tada reaction heads its own group');
            const reactor = tadaHeader?.nextElementSibling;
            ok(!!reactor && reactor.classList.contains('tgw-menu-submenu-row'), 'the group is followed by the people who used it');
            ok(!!reactor && (reactor.textContent || '').includes('Alice Anderson'), `the reactor row shows the full name (${reactor && (reactor.textContent || '').trim()})`);
            ok(!!reactor?.querySelector('img'), 'reactor rows include avatars like the seen list');
            const details = (reactor && reactor.getAttribute('title')) || '';
            ok(details.includes('Alice Anderson (alley)'), `hovering the name shows the full name (${details})`);
            ok(details.includes(' · ') && (details.includes('Today') || details.includes('Yesterday') || /\d{4}/.test(details)), 'hovering also shows when they reacted');
            let dividers = 0;
            panel.querySelectorAll('.tgw-menu-separator').forEach(() => dividers++);
            ok(dividers === 1, `a horizontal divider separates the emoji groups (${dividers})`);
            reactor?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
            await waitFor(() => !document.querySelector('.tgw-menu'));
            await waitFor(() => document.querySelector('.tgw-chat-header-title')?.textContent === 'Alice Anderson (alley)');
            ok(calls.some((call) => call === 'POST /channels/direct'), 'clicking a reactor opens a direct chat with them');
        }
    }

    console.log('\n== quick reactions from the post menu ==');
    {
        // Telegram puts one-tap reactions on top of the post context menu: 🙏 👍 👎 💪.
        const p3row = Array.from(document.querySelectorAll('.tgw-msg-in')).find((row) => row.getAttribute('data-post-id') === 'p3');
        ok(!!p3row, 'p3 rendered for the quick-reaction check');
        p3row?.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, clientX: 120, clientY: 200}));
        await waitFor(() => document.querySelector('.tgw-menu'));
        const emojiRow = await waitFor(() => document.querySelector('.tgw-menu-emoji-row'));
        ok(!!emojiRow, 'the post menu opens with the quick-reaction row');
        const emojiButtons = Array.from(document.querySelectorAll('.tgw-menu-emoji'));
        ok(emojiButtons.map((button) => button.textContent).join('') === '🙏👍👎💪', `the row holds all four emoji (${emojiButtons.map((button) => button.textContent).join(' ')})`);
        ok(!!emojiRow && emojiRow.textContent === '🙏👍👎💪', 'the emoji row shows only the emoji, no captions');
        const menuItems = Array.from(document.querySelectorAll('.tgw-menu-item'));
        ok(!!menuItems[0] && menuItems[0].textContent.includes('Reply'), 'the labelled entries (Reply …) follow the emoji row');

        const beforeReact = calls.length;
        const likeButton = emojiButtons.find((button) => button.textContent === '👍');
        likeButton?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => calls.slice(beforeReact).some((call) => call === 'POST /reactions'), 3000);
        const reactionPayload = payloads.filter((entry) => entry.path === '/reactions').pop();
        ok(reactionPayload?.body?.emoji_name === '+1', `picking \ud83d\udc4d reacts with “+1” (got: ${JSON.stringify(reactionPayload && reactionPayload.body)})`);
        ok(!document.querySelector('.tgw-menu'), 'picking a quick reaction closes the menu');
        const chipShown = await waitFor(() => Array.from(document.querySelectorAll('.tgw-reaction')).some((chip) => chip.textContent.includes('👍')));
        ok(!!chipShown, 'the reaction chip appears without a reload');

        // Opening the menu again shows the emoji I joined as tinted; clicking it takes the
        // reaction away again.
        const beforeRemove = calls.length;
        p3row?.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, clientX: 120, clientY: 200}));
        await waitFor(() => document.querySelector('.tgw-menu'));
        const joinedButton = Array.from(document.querySelectorAll('.tgw-menu-emoji')).find((button) => button.textContent === '👍');
        ok(!!joinedButton && joinedButton.classList.contains('tgw-menu-emoji-active'), 'a reaction I already joined stays tinted in the row');
        joinedButton?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => calls.slice(beforeRemove).some((call) => call.startsWith('DELETE') && call.includes('/reactions/')), 3000);
        ok(calls.slice(beforeRemove).some((call) => call.startsWith('DELETE') && call.includes('/reactions/')), 'clicking it again removes my reaction');
    }

    console.log('\n== copy selected text from the context menu ==');
    {
        const p1row = Array.from(document.querySelectorAll('.tgw-msg-in')).find((row) => row.getAttribute('data-post-id') === 'p1');
        ok(!!p1row, 'p1 rendered for the selection check');

        // With nothing selected the row must not pad the menu.
        p1row?.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, clientX: 140, clientY: 210}));
        await waitFor(() => document.querySelector('.tgw-menu'));
        const withoutSelection = Array.from(document.querySelectorAll('.tgw-menu-item')).find((item) => item.textContent.includes('Copy selected text'));
        ok(!withoutSelection, 'with no selection the context menu has no "Copy selected text" row');
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        await waitFor(() => !document.querySelector('.tgw-menu'));

        // Highlight part of the message text…
        const textEl = p1row ? p1row.querySelector('.tgw-message-text') : null;
        const walker = dom.window.document.createTreeWalker(textEl || p1row, dom.window.NodeFilter.SHOW_TEXT, null);
        let node = walker.nextNode();
        while (node && !(node.data || '').includes('How are you')) {
            node = walker.nextNode();
        }
        ok(!!node, 'found the message text node to select');

        // …and capture what the row will copy: jsdom ships no navigator.clipboard, so install
        // one when the object accepts it and fall back to asserting only the visible toast
        // when it does not (the production clipboard path still resolves either way).
        const copied = [];
        let stubbed = false;
        try {
            Object.defineProperty(dom.window.navigator, 'clipboard', {
                configurable: true,
                value: {
                    __tgwStub: true,
                    writeText: (text) => {
                        copied.push(text);
                        return Promise.resolve();
                    },
                },
            });
            stubbed = !!(navigator.clipboard && navigator.clipboard.__tgwStub);
        } catch (err) {
            stubbed = false;
        }

        if (node) {
            const phrase = 'How are you';
            const start = node.data.indexOf(phrase);
            const range = dom.window.document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + phrase.length);
            const selection = dom.window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            ok(!selection.isCollapsed, 'the test selection is active');

            p1row?.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, clientX: 140, clientY: 210}));
            await waitFor(() => document.querySelector('.tgw-menu'));
            const row = Array.from(document.querySelectorAll('.tgw-menu-item')).find((item) => item.textContent.includes('Copy selected text'));
            ok(!!row, 'with text selected the context menu offers "Copy selected text"');
            const labels = Array.from(document.querySelectorAll('.tgw-menu-item')).map((item) => item.textContent.trim());
            ok(labels.indexOf('Copy selected text') + 1 === labels.indexOf('Copy text'), 'selected text appears immediately above copy text');

            row?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
            const toastShown = await waitFor(() => Array.from(document.querySelectorAll('.tgw-toast')).some((entry) => entry.textContent.includes('Selected text copied')));
            ok(!!toastShown, 'clicking it copies and confirms with a success toast');
            if (stubbed) {
                ok(copied[0] === phrase, `exactly the selected text is copied (got: ${JSON.stringify(copied[0])})`);
            }
            selection.removeAllRanges();
        }
    }

    console.log('\n== copy message URL from its context menu ==');
    {
        const p3row = document.querySelector('[data-post-id="p3"]');
        const link = p3row?.querySelector('.tgw-message-text a[href="https://example.com/run"]');
        ok(!!link, 'linked URL is available in the message');
        const copied = [];
        Object.defineProperty(dom.window.navigator, 'clipboard', {
            configurable: true,
            value: {writeText: (text) => { copied.push(text); return Promise.resolve(); }},
        });
        link?.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 140, clientY: 210}));
        await waitFor(() => document.querySelector('.tgw-menu'));
        const copyURL = Array.from(document.querySelectorAll('.tgw-menu-item')).find((item) => item.textContent.trim() === 'Copy URL');
        ok(!!copyURL, 'the link context menu offers Copy URL');
        copyURL?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => Array.from(document.querySelectorAll('.tgw-toast')).some((item) => item.textContent.includes('URL copied')));
        ok(copied[0] === link?.href, 'Copy URL copies the link destination');
    }

    console.log('\n== forwarding and download URLs ==');
    {
        const p1row = document.querySelector('[data-post-id="p1"]');
        p1row?.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, clientX: 140, clientY: 210}));
        await waitFor(() => document.querySelector('.tgw-menu'));
        const menuItem = (label) => Array.from(document.querySelectorAll('.tgw-menu-item')).find((item) => item.textContent.trim() === label);
        ok(!!menuItem('Copy download URL: photo-one.png'), 'each attachment offers a download URL');
        const copiedURLs = [];
        Object.defineProperty(dom.window.navigator, 'clipboard', {configurable: true, value: {writeText: (value) => {copiedURLs.push(value); return Promise.resolve();}}});
        menuItem('Copy download URL: photo-one.png')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => !document.querySelector('.tgw-menu'));
        ok(copiedURLs[0] === 'https://mattermost.example.com/api/v4/files/file-1?download=1', 'download URL is absolute and points to the file');
        p1row?.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, clientX: 140, clientY: 210}));
        await waitFor(() => document.querySelector('.tgw-menu'));
        menuItem('Forward')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('[role="dialog"][aria-label="Forward message"]'));
        const destination = Array.from(document.querySelectorAll('.tgw-modal .tgw-picker-row')).find((row) => row.textContent.includes('Town Square'));
        ok(!!destination, 'forward picker offers another chat');
        destination?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => payloads.some((entry) => entry.path === '/plugins/com.telegramweb.ui/api/v1/forward'));
        const request = payloads.find((entry) => entry.path === '/plugins/com.telegramweb.ui/api/v1/forward');
        ok(request?.body?.post_id === 'p1' && request?.body?.channel_id === ids.TOWN, 'forward request sends source post and destination');
        await waitFor(() => !document.querySelector('[role="dialog"][aria-label="Forward message"]'));
    }

    console.log('\n== attachments, thread, image viewer ==');
    const thumbs = document.querySelectorAll('.tgw-attachment-image');
    ok(thumbs.length >= 2, `image attachments render in the chat (${thumbs.length})`);
    const chatImgSrc = document.querySelector('.tgw-attachment-image img')?.getAttribute('src') || '';
    ok(chatImgSrc.includes('/preview'), `chat images render the high-quality preview, not the 480px thumbnail (${chatImgSrc})`);

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
    const getUserMedia = dom.window.navigator.mediaDevices.getUserMedia;
    dom.window.navigator.mediaDevices.getUserMedia = async () => { throw new Error('denied'); };
    document.querySelector('.tgw-composer-icon[title="Record a voice message"]')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await waitFor(() => document.querySelector('.tgw-toasts-top-right .tgw-toast'));
    ok((document.querySelector('.tgw-toasts-top-right')?.textContent || '').includes('Microphone access denied'), 'microphone denial appears at the top right');
    dom.window.navigator.mediaDevices.getUserMedia = getUserMedia;

    console.log('\n== shared files panel ==');
    // The right-hand "Shared files" menu is minimized by default and is not rendered until the
    // chat header (or the header menu) asks for it.
    ok(!document.querySelector('.tgw-files-panel'), 'shared files panel starts collapsed');
    document.querySelector('button[title="Shared files"]')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await waitFor(() => document.querySelector('.tgw-files-panel'));
    ok(!!document.querySelector('.tgw-files-panel'), 'header button opens the shared files panel');
    const fileRows = document.querySelectorAll('.tgw-files-panel .tgw-file-row');
    ok(fileRows.length >= 3, `panel lists every file of the chat (${fileRows.length})`);
    ok(!!Array.from(fileRows).find((row) => (row.textContent || '').includes('photo-one.png')), 'image attachments are listed by name');
    ok(!!Array.from(fileRows).find((row) => (row.textContent || '').includes('voice-message-2023-11-15.webm')), 'voice message files are listed too');
    ok(!!document.querySelector('.tgw-files-panel .tgw-files-search input[placeholder="Search file names"]'), 'panel has a file-name search bar');

    // Images read as pictures in the list; every other kind carries its extension on the
    // icon (annual-report.pdf → PDF, the voice message → WEBM), like Mattermost's file list.
    ok(!!document.querySelector('.tgw-files-panel .tgw-file-thumb img'), 'image files show a thumbnail in the panel');
    const panelIcons = Array.from(document.querySelectorAll('.tgw-files-panel .tgw-file-icon')).map((el) => (el.textContent || '').trim());
    ok(panelIcons.includes('PDF'), `non-image files show their extension on the icon (${panelIcons.join(', ')})`);
    ok(panelIcons.includes('WEBM'), 'voice messages keep their extension icon too');

    // Typing a name filters the rows; names that match nothing fall back to a hint.
    const fileSearch = document.querySelector('.tgw-files-panel .tgw-files-search input');
    if (fileSearch) {
        const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
        valueSetter.call(fileSearch, 'photo-one');
        fileSearch.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(60);
        const afterFilter = document.querySelectorAll('.tgw-files-panel .tgw-file-row');
        ok(afterFilter.length === 1 && (afterFilter[0].textContent || '').includes('photo-one.png'), `search narrows the list to matching names (${afterFilter.length} row)`);
        valueSetter.call(fileSearch, 'zzz-no-match');
        fileSearch.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(60);
        ok(document.querySelectorAll('.tgw-files-panel .tgw-file-row').length === 0, 'a non-matching name hides every row');
        ok(document.querySelector('.tgw-files-panel .tgw-empty-list') !== null, 'a no-results hint is shown');
        valueSetter.call(fileSearch, '');
        fileSearch.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(60);
    }

    // Scope + listing source: the note states that the whole history is covered, and the list
    // itself comes from the team file search — no message-text search, no history walk.
    const scopeNote = document.querySelector('.tgw-files-scope');
    ok(!!scopeNote && /Every file/.test(scopeNote.textContent || ''), `the panel states the listing scope (${scopeNote && scopeNote.textContent})`);
    ok(calls.some((call) => call === 'POST /teams/team-1/files/search'), 'the list is loaded through the team file search');
    if (fileSearch) {
        const remoteSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
        // "annual" appears in no message text — only in the file name on p-old, a message older
        // than the window the chat loads — so its row can only come from the files/search call.
        const searchesBefore = calls.filter((call) => call.includes('/posts/search')).length;
        const fileSearchesBefore = calls.filter((call) => call === 'POST /teams/team-1/files/search').length;
        remoteSetter.call(fileSearch, 'annual');
        fileSearch.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(60);
        const olderFileRow = Array.from(document.querySelectorAll('.tgw-files-panel .tgw-file-row')).find((row) => (row.textContent || '').includes('annual-report.pdf'));
        ok(!!olderFileRow, 'a file from an older, unfetched message is listed under its name');
        ok(calls.filter((call) => call.includes('/posts/search')).length === searchesBefore, 'the file list never goes through the message search');
        // The typed needle joins the channel modifier on the debounced files/search request,
        // exactly the way the stock app's file browser searches.
        await tick(450); // > the 350ms debounce
        const fileSearchesAfter = calls.filter((call) => call === 'POST /teams/team-1/files/search').length;
        ok(fileSearchesAfter > fileSearchesBefore, `typing re-queries the team file search (${fileSearchesBefore} → ${fileSearchesAfter})`);
        const lastTerms = payloads.filter((entry) => entry.path === '/teams/team-1/files/search').pop();
        ok(!!lastTerms && lastTerms.body && String(lastTerms.body.terms) === 'channel:channel-dm annual',
            `the search terms carry the channel modifier plus the needle (${lastTerms && lastTerms.body && lastTerms.body.terms})`);
        ok(!document.querySelector('.tgw-files-scope'), 'the scope note hides while a filter is active');
        // The jump fetches the message the file hangs off (older than the loaded window) and
        // lands the chat on it with the flash highlight.
        if (olderFileRow) {
            olderFileRow.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
            await waitFor(() => document.querySelector('.tgw-post-highlight')?.getAttribute('data-post-id') === 'p-old', 3000);
            ok(calls.some((call) => call === 'GET /posts/p-old'), 'clicking it fetches the older message on demand');
            ok(document.querySelector('.tgw-post-highlight')?.getAttribute('data-post-id') === 'p-old',
                'clicking a file older than the loaded window lands the chat on its message');
        }
        remoteSetter.call(fileSearch, '');
        fileSearch.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(60);
    }

    // Ctrl/Cmd+A inside a text field stays inside it: nothing downstream — the host app's
    // document handlers, this overlay's own — may see the key and widen the selection.
    if (fileSearch) {
        let outsideSaw = false;
        const spy = () => {
            outsideSaw = true;
        };
        document.addEventListener('keydown', spy);
        fileSearch.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'a', ctrlKey: true, bubbles: true, cancelable: true}));
        document.removeEventListener('keydown', spy);
        ok(!outsideSaw, 'Ctrl+A in a text field never reaches outer keydown handlers');
    }

    // The panel's own header button collapses it again (it is collapsible, not modal).
    document.querySelector('.tgw-files-panel .tgw-info-header .tgw-icon-button')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await waitFor(() => !document.querySelector('.tgw-files-panel'));
    ok(!document.querySelector('.tgw-files-panel'), 'collapse button minimizes the panel again');

    // Clicking a file lands on the message that shared it instead of opening a new tab.
    document.querySelector('button[title="Shared files"]')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await waitFor(() => document.querySelector('.tgw-files-panel'));
    const photoRow = Array.from(document.querySelectorAll('.tgw-files-panel .tgw-file-row'))
        .find((row) => (row.textContent || '').includes('photo-one.png'));
    ok(!!photoRow && photoRow.tagName === 'BUTTON', 'file rows are buttons, not links to a new tab');
    ok(!document.querySelector('.tgw-files-panel .tgw-file-row[href]'), 'no file row points at a raw file URL');
    if (photoRow) {
        photoRow.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-post-highlight'));
        const landed = document.querySelector('.tgw-post-highlight');
        ok(!!landed && landed.getAttribute('data-post-id') === 'p1',
            `clicking a file scrolls to its message with the flash highlight (${landed && landed.getAttribute('data-post-id')})`);
    }

    // The phone layout's back button drops the chat *and* the files panel: the panel overlays
    // the chat on mobile, so leaving it open would cover the chat list we just came back to —
    // and reopening the chat must not resurrect it.
    const wideWidth = dom.window.innerWidth;
    Object.defineProperty(dom.window, 'innerWidth', {value: 500, configurable: true, writable: true});
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    await waitFor(() => document.querySelector('.tgw-back-button'));
    ok(!!document.querySelector('.tgw-back-button'), 'the chat header shows the back button in the phone layout');
    document.querySelector('.tgw-back-button')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await waitFor(() => !document.querySelector('.tgw-files-panel'));
    ok(!document.querySelector('.tgw-files-panel'), 'the back button closes the open files panel too');
    Object.defineProperty(dom.window, 'innerWidth', {value: wideWidth, configurable: true, writable: true});
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    await waitFor(() => !document.querySelector('.tgw-back-button'));
    // Back on the wide layout: reopening the same chat must not bring the panel back.
    const dmRowAgain = Array.from(document.querySelectorAll('.tgw-chat-row')).find((row) => row.textContent.includes('Alice Anderson'));
    dmRowAgain?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await tick(60);
    ok(!!document.querySelector('.tgw-chat-header-title') && !document.querySelector('.tgw-files-panel'),
        'reopening the chat after going back keeps the files panel closed');

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

        // The group eye tally: two seeded viewers on a fresh group message, own view excluded
        // (both in the set, my own look subtracted → the bubble shows 1).
        viewTracking.set('p-town-views', new Set([ids.ME, ids.OTHER]));
        handleSocketEvent('posted', {event: 'posted', data: {post: JSON.stringify({
            id: 'p-town-views', create_at: Date.now(), update_at: Date.now(), edit_at: 0, delete_at: 0,
            user_id: ids.OTHER, channel_id: ids.TOWN, message: 'Group notes for the retro', type: '', props: {}, root_id: '', metadata: {}})}});
        await waitFor(() => document.querySelector('.tgw-msg-views'), 3000);
        const townViews = (document.querySelector('.tgw-msg-views')?.textContent || '').trim();
        ok(townViews === '1', `group messages show the view tally, own view excluded (${townViews || 'nothing'})`);
        ok(!!document.querySelector('.tgw-msg-views svg'), 'the tally carries the eye icon');
        document.querySelector('.tgw-msg-views')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-msg-viewers'));
        ok((document.querySelector('.tgw-msg-viewers')?.textContent || '').includes('Alice Anderson'), 'channel tally opens the names of people who saw the post');
        ok(!!document.querySelector('.tgw-msg-viewer time[datetime]'), 'viewer list shows when each person saw the post');
        const viewerSearch = document.querySelector('.tgw-msg-viewers-search');
        ok(!!viewerSearch, 'viewer popup includes a search field');
        viewerSearch.value = 'nobody';
        viewerSearch.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-msg-viewers-empty')?.textContent === 'No matching viewers');
        viewerSearch.value = 'alice';
        viewerSearch.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await waitFor(() => (document.querySelector('.tgw-msg-viewers-list')?.textContent || '').includes('Alice Anderson'));

        // Channels/groups refresh that tally every five seconds — never at the direct-chat
        // one-second cadence. The mount fetch has landed (the eye is on screen), so what
        // follows is purely the interval's doing; the DM list is unmounted, no other view
        // GETs can arrive in this window.
        const groupGets = () => calls.filter((call) => call.startsWith('GET /plugins/com.telegramweb.ui/api/v1/views')).length;
        const mountedGets = groupGets();
        await tick(1500);
        ok(groupGets() === mountedGets, `no group refresh within 1.5s of the last one (${groupGets()} fetches)`);
        await waitFor(() => groupGets() > mountedGets, 4500);
        ok(groupGets() > mountedGets, `group view tally re-polls every five seconds (${mountedGets} → ${groupGets()})`);

        document.querySelector('.tgw-msg-viewer')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-chat-header-title')?.textContent === 'Alice Anderson (alley)');
        ok(!document.querySelector('.tgw-msg-viewers'), 'clicking a seen user closes the viewer list');
        ok(calls.some((call) => call === 'POST /channels/direct'), 'clicking a seen user opens their direct chat');
        const townSidebarRow = Array.from(document.querySelectorAll('.tgw-chat-row')).find((row) => row.textContent.includes('Town Square'));
        townSidebarRow?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-chat-header-title')?.textContent === 'Town Square');

        // Info panel members must come from the REST list, not the sparse host Redux copy.
        document.querySelector('.tgw-chat-header-main')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-members'));
        const memberNames = Array.from(document.querySelectorAll('.tgw-member-name')).map((node) => node.textContent);
        ok(memberNames.includes('Nina Novak'), 'member list shows people the host store never loaded');
        ok(memberNames.length === 3, `member list renders every member (${memberNames.length})`);
        ok(document.body.innerHTML.includes('3 members'), 'member count label matches the list');
        Array.from(document.querySelectorAll('.tgw-member')).find((row) => row.textContent.includes('Nina Novak'))?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-chat-header-title')?.textContent === 'Nina Novak');
        ok(calls.some((call) => call === 'POST /channels/direct'), 'clicking a channel member opens their direct chat');
        Array.from(document.querySelectorAll('.tgw-chat-row')).find((row) => row.textContent.includes('Town Square'))?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-chat-header-title')?.textContent === 'Town Square');
        document.querySelector('.tgw-chat-header-main')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-members'));
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
    clickFolder('All');
    await waitFor(() => (folderBtn('All')?.className || '').includes('tgw-folder-active'));
    state.entities.preferences = {
        myPreferences: {
            ...state.entities.preferences.myPreferences,
            [`favorite_channel--${ids.TOWN}`]: {category: 'favorite_channel', name: ids.TOWN, user_id: ids.ME, value: 'true'},
        },
    };
    notifyStoreChange();
    const allChatTitles = () => Array.from(document.querySelectorAll('.tgw-sidebar-body .tgw-chat-row-title')).map((el) => el.textContent.trim());
    await waitFor(() => allChatTitles()[0] === 'Town Square');
    ok(allChatTitles()[0] === 'Town Square' && allChatTitles()[1]?.startsWith('Alice Anderson') && allChatTitles().length === 2, `All shows unread chats first without duplicating favorites (${allChatTitles().join(',')})`);
    const allSectionTitles = () => Array.from(document.querySelectorAll('.tgw-sidebar-body .tgw-section-title')).map((el) => el.textContent.trim());
    ok(allSectionTitles().includes('Unread') && allSectionTitles().every((title) => title === 'Unread' || title === 'Chats'), `All groups chats only under Unread and Chats (${allSectionTitles().join(',')})`);
    ok(!allSectionTitles().includes('Favorites'), 'All does not show a separate Favorites section');
    ok(!!document.querySelector('.tgw-chat-row-star'), 'seeding the favorite preference lights up the star on the row');
    const favRow = Array.from(document.querySelectorAll('.tgw-chat-row')).find((row) => row.textContent.includes('Town Square'));
    ok(!!favRow, 'town square row found for the favorites check');
    if (favRow) {
        const townRowAfterRead = Array.from(document.querySelectorAll('.tgw-chat-row')).find((row) => row.textContent.includes('Town Square'));
        townRowAfterRead?.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, clientX: 60, clientY: 60}));
        await waitFor(() => document.querySelector('.tgw-menu'));
        const readActions = () => Array.from(document.querySelectorAll('.tgw-menu-item'))
            .map((el) => (el.textContent || '').trim())
            .filter((label) => label === 'Mark as read' || label === 'Mark as unread');
        ok(readActions().join(',') === 'Mark as read', 'an unread chat offers only Mark as read');
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        await waitFor(() => !document.querySelector('.tgw-menu'));

        const townMember = state.entities.channels.myMembers[ids.TOWN];
        state.entities.channels.myMembers = {
            ...state.entities.channels.myMembers,
            [ids.TOWN]: {...townMember, msg_count: state.entities.channels.channels[ids.TOWN].total_msg_count, mention_count: 0},
        };
        notifyStoreChange();
        await tick(50);
        const townRowAfterRestore = Array.from(document.querySelectorAll('.tgw-chat-row')).find((row) => row.textContent.includes('Town Square'));
        townRowAfterRestore?.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, clientX: 60, clientY: 60}));
        await waitFor(() => document.querySelector('.tgw-menu'));
        ok(readActions().join(',') === 'Mark as unread', `a read chat offers only Mark as unread (${readActions().join(',') || 'none'})`);
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        await waitFor(() => !document.querySelector('.tgw-menu'));
        state.entities.channels.myMembers = {...state.entities.channels.myMembers, [ids.TOWN]: townMember};
        notifyStoreChange();

        const townRowWithUnreadRestored = Array.from(document.querySelectorAll('.tgw-chat-row')).find((row) => row.textContent.includes('Town Square'));
        townRowWithUnreadRestored?.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, clientX: 60, clientY: 60}));
        await waitFor(() => document.querySelector('.tgw-menu'));
        const removeEntry = Array.from(document.querySelectorAll('.tgw-menu-item')).find((el) => el.textContent.includes('Remove from favorites'));
        ok(!!removeEntry, 'context menu offers removing the chat from favorites');
        const muteEntry = Array.from(document.querySelectorAll('.tgw-menu-item')).find((el) => el.textContent.trim() === 'Mute');
        ok(!!muteEntry?.querySelector('svg'), 'mute menu item has an icon');
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
    const townMemberBeforeFinalSort = state.entities.channels.myMembers[ids.TOWN];
    state.entities.channels.myMembers = {
        ...state.entities.channels.myMembers,
        [ids.TOWN]: {...state.entities.channels.myMembers[ids.TOWN], msg_count: state.entities.channels.channels[ids.TOWN].total_msg_count},
    };
    state.entities.preferences = {
        myPreferences: {
            ...state.entities.preferences.myPreferences,
            [`favorite_channel--${ids.TOWN}`]: {category: 'favorite_channel', name: ids.TOWN, user_id: ids.ME, value: 'false'},
        },
    };
    notifyStoreChange();
    await waitFor(() => allChatTitles()[0] === 'Alice Anderson');
    ok(allChatTitles()[0]?.startsWith('Alice Anderson') && allChatTitles()[1] === 'Town Square', `removing a favorite restores recent-chat order (${allChatTitles().join(',')})`);
    ok(!allSectionTitles().includes('Favorites'), `All keeps favorites out of a separate section after removal (${allSectionTitles().join(',')})`);
    state.entities.channels.myMembers = {...state.entities.channels.myMembers, [ids.TOWN]: townMemberBeforeFinalSort};
    notifyStoreChange();

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

    console.log('\n== chat preview emoji ==');
    {
        // The chat-row preview is plain text, so a custom emoji (which has no unicode character
        // at all) is drawn from the server's own image while an unknown name stays as typed.
        handleSocketEvent('posted', {event: 'posted', data: {post: JSON.stringify({
            id: 'p-preview-emoji', create_at: Date.now(), update_at: Date.now(), edit_at: 0, delete_at: 0,
            user_id: posts.p1.user_id, channel_id: ids.DM, message: 'dance :party_parrot: and :shipit: now',
            type: '', props: {}, root_id: '', metadata: {}})}});
        await waitFor(() => !!document.querySelector('.tgw-chat-row-preview img.tgw-inline-emoji'));
        // Scope to the DM's own row: the active folder tab lists Town Square first.
        const dmRow = Array.from(document.querySelectorAll('.tgw-chat-row')).find((row) => row.textContent.includes('Alice Anderson'));
        const previewCell = dmRow?.querySelector('.tgw-chat-row-preview');
        const customImg = previewCell?.querySelector('img.tgw-inline-emoji');
        ok(customImg?.getAttribute('alt') === ':party_parrot:', 'a custom emoji renders as an image in the chat preview');
        ok((customImg?.getAttribute('src') || '').includes('/emoji/emoji-1/image'), 'the image points at the server-served custom emoji');
        const previewText = previewCell?.textContent || '';
        ok(previewText.includes(':shipit:'), 'a name the server does not have stays as typed');
        ok(!previewText.includes(':party_parrot:'), 'the resolved custom emoji is no longer raw text');
    }

    console.log('\n== search ==');
    const searchInput = document.querySelector('.tgw-search input');
    if (searchInput) {
        const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
        valueSetter.call(searchInput, 'Alice');
        searchInput.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(60);
        ok(document.body.innerHTML.includes('Contacts'), 'global search renders contact results');
        ok(document.body.innerHTML.includes('Alice Anderson (alley)'), 'search results label people as First Last (nickname)');
        const contactsHeading = Array.from(document.querySelectorAll('.tgw-search-results .tgw-section-title')).find((el) => el.textContent.trim() === 'Contacts');
        const contactRow = contactsHeading?.nextElementSibling?.querySelector('.tgw-chat-row');
        contactRow?.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, clientX: 60, clientY: 60}));
        await waitFor(() => !!document.querySelector('.tgw-menu'));
        ok(Array.from(document.querySelectorAll('.tgw-menu-item')).some((el) => el.textContent.trim() === 'Mark as read' || el.textContent.trim() === 'Mark as unread'), 'searched contact with a DM opens its chat context menu');
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        await waitFor(() => !document.querySelector('.tgw-menu'));

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
            await waitFor(() => document.querySelector('.tgw-chat-header-title')?.textContent === 'Alice Anderson (alley)', 3000);
            ok(!document.querySelector('.tgw-search-panel'), 'clicking a hit closes the wide panel');
            await waitFor(() => !!document.querySelector('.tgw-post-highlight'), 3000);
            ok(!!document.querySelector('.tgw-post-highlight'), 'clicking a hit opens the chat at the matched message');
        }

        // A hit older than the first loaded page (p-old) exists only through search: clicking it
        // must fetch it on demand so the chat lands on the message instead of just opening.
        valueSetter.call(searchInput, 'deploy');
        searchInput.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        // The predicate must look for the hit row itself: the word "pipeline" also appears in
        // the chat body once p-old is fetched into the open conversation.
        await waitFor(() => Array.from(document.querySelectorAll('.tgw-message-hit')).some((row) => row.textContent.includes('pipeline')), 3000);
        const oldHit = Array.from(document.querySelectorAll('.tgw-message-hit')).find((row) => row.textContent.includes('pipeline'));
        ok(!!oldHit, 'the off-screen message shows up as a sidebar search hit');
        if (oldHit) {
            oldHit.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
            // The on-demand fetch itself is covered by the files-panel jump above and, with a
            // cold cache, by the browser test. Here p-old already sits in the post cache (the
            // files panel fetched it), so only the landing is left to check — and its flash
            // window is 2.4s, so go straight for the highlight instead of waiting for a fetch
            // that must not happen.
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

    // Server-side style + background defaults (System Console → plugin settings) apply to a user
    // without their own saved copy; the user's own preference wins once it exists.
    const settingsLocalKey = 'tgw.settings.com.telegramweb.ui';
    const pluginConfigKey = 'com.telegramweb.ui';
    const savedLocalSettings = dom.window.localStorage.getItem(settingsLocalKey);
    const originalPluginConfig = {...(state.entities.general.config.PluginSettings.Plugins[pluginConfigKey] || {})};
    dom.window.localStorage.removeItem(settingsLocalKey);
    state.entities.general.config.PluginSettings.Plugins[pluginConfigKey] = {
        ...originalPluginConfig,
        DefaultWallpaper: 'dots',
        DefaultCompactMode: true,
        DefaultGlassyMode: false,
        DefaultJalali: false,
    };
    initSettings();
    await tick(60);
    ok(getSettings().wallpaper === 'dots', `the admin default background from the plugin config wins for fresh users (${getSettings().wallpaper})`);
    ok(getSettings().compactMode === true && getSettings().glassyMode === false, 'the admin default style flags are applied');
    ok(getSettings().jalali === false, 'the admin DefaultJalali=false switches the calendar off for fresh users');
    state.entities.general.config.PluginSettings.Plugins[pluginConfigKey] = originalPluginConfig;
    if (savedLocalSettings !== null) {
        dom.window.localStorage.setItem(settingsLocalKey, savedLocalSettings);
    }
    initSettings();
    await tick(60);
    ok(getSettings().wallpaper === 'doodles' && getSettings().compactMode === false && getSettings().glassyMode === true,
        `the user's own settings win again after the server-defaults check (${getSettings().wallpaper}, compact=${getSettings().compactMode}, glassy=${getSettings().glassyMode})`);
    ok(getSettings().jalali === true, `the user's own Jalali choice wins over the admin default again (${getSettings().jalali})`);

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
    updateSettings({quietUnreadCounts: true});
    await tick(60);
    const allFolder = Array.from(document.querySelectorAll('.tgw-folder')).find((button) => button.textContent.includes('All'));
    ok(!!allFolder?.querySelector('.tgw-folder-dot'), 'quiet unread counts add a dot for unread channel messages');
    ok(!!allFolder?.querySelector('.tgw-folder-badge'), 'quiet unread counts retain a number for direct messages and mentions');
    updateSettings({quietUnreadCounts: false});
    await tick(60);

    console.log('\n== jalali dates ==');
    {
        // Pure conversion math on timezone-free Gregorian tuples.
        const {toJalali} = require('../src/mm/jalali');
        const {formatChatTime} = require('../src/mm/utils');
        const fmt = {military: true, locale: 'en'};
        // Mid-November 2023: in every timezone its local date falls on Aban 23/24, 1402 — that
        // month/year stability is exactly what the patterns below pin down.
        const fixture = 1_700_000_100_000;

        const farvardin1402 = toJalali(2023, 3, 21);
        ok(farvardin1402.jy === 1402 && farvardin1402.jm === 1 && farvardin1402.jd === 1,
            `Nowruz 1402 falls on 2023-03-21 (got ${farvardin1402.jy}-${farvardin1402.jm}-${farvardin1402.jd})`);
        const farvardin1403 = toJalali(2024, 3, 20);
        ok(farvardin1403.jy === 1403 && farvardin1403.jm === 1 && farvardin1403.jd === 1,
            `Nowruz 1403 falls on 2024-03-20 (got ${farvardin1403.jy}-${farvardin1403.jm}-${farvardin1403.jd})`);
        // Literal day pins, cross-checked against ICU's Persian calendar: Dey 11 and the
        // fixture's own day (mid-November 2023 = Aban 23, 1402).
        const dey11 = toJalali(2023, 1, 1);
        ok(dey11.jy === 1401 && dey11.jm === 10 && dey11.jd === 11,
            `2023-01-01 is Dey 11, 1401 (got ${dey11.jy}-${dey11.jm}-${dey11.jd})`);
        const aban23 = toJalali(2023, 11, 14);
        ok(aban23.jy === 1402 && aban23.jm === 8 && aban23.jd === 23,
            `2023-11-14 is Aban 23, 1402 (got ${aban23.jy}-${aban23.jm}-${aban23.jd})`);

        // 700 consecutive Gregorian days (two full Jalali years): every step must land on exactly
        // the next Jalali day — month lengths, leap Esfand and both year rollovers included.
        let cursor = Date.UTC(2023, 2, 21);
        let prev = null;
        let drift = '';
        for (let i = 0; i < 700 && !drift; i += 1) {
            const d = new Date(cursor);
            const p = toJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
            const monthMax = p.jm <= 6 ? 31 : p.jm <= 11 ? 30 : 30; // Esfand is 29/30 (leap).
            if (p.jm < 1 || p.jm > 12 || p.jd < 1 || p.jd > monthMax) {
                drift = `invalid parts ${p.jy}-${p.jm}-${p.jd}`;
            } else if (prev) {
                const sameMonth = p.jy === prev.jy && p.jm === prev.jm && p.jd === prev.jd + 1;
                const nextMonth = p.jy === prev.jy && p.jm === prev.jm + 1 && p.jd === 1
                    && prev.jd === (prev.jm <= 6 ? 31 : 30); // rolls exactly at the month's end.
                const nextYear = p.jy === prev.jy + 1 && p.jm === 1 && p.jd === 1
                    && prev.jm === 12 && (prev.jd === 29 || prev.jd === 30); // the leap fork.
                if (!sameMonth && !nextMonth && !nextYear) {
                    drift = `${p.jy}-${p.jm}-${p.jd} does not follow ${prev.jy}-${prev.jm}-${prev.jd}`;
                }
            }
            prev = {jy: p.jy, jm: p.jm, jd: p.jd};
            cursor += 86400000;
        }
        ok(drift === '', drift ? `day-by-day conversion drifted: ${drift}`
            : '700 consecutive days map onto consecutive valid Jalali days');

        // The chat-list formatter speaks Jalali under the default (dd.MM.yy → 24.08.02).
        const chatTime = formatChatTime(fixture, fmt);
        ok(/^\d{2}\.(0[1-9]|1[0-2])\.02$/.test(chatTime),
            `formatChatTime renders the Jalali dd.MM.yy (${chatTime})`);

        // The rendered chat follows the admin default (DefaultJalali: true): stamps, date
        // separators — all live DOM, not just the helper.
        const stamp = document.querySelector('.tgw-msg-time')?.textContent || '';
        ok(/\bAba\b/.test(stamp) && /1402/.test(stamp) && !/202\d/.test(stamp),
            `message stamps render in the Jalali calendar (${stamp})`);
        const separator = document.querySelector('.tgw-date-separator')?.textContent || '';
        ok(/\bAban\b/.test(separator) && /1402/.test(separator),
            `the date separator carries the Jalali month and year (${separator})`);

        // Per-user control through the settings screen itself.
        document.querySelector('button[title="Menu"]')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-menu'));
        const settingsEntry = Array.from(document.querySelectorAll('.tgw-menu-item'))
            .find((el) => (el.textContent || '').trim().startsWith('Settings'));
        ok(!!settingsEntry, 'the main menu offers the settings screen');
        settingsEntry?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-modal'));
        ok(!!document.querySelector('.tgw-modal'), 'the settings modal opens');
        const jalaliToggle = () => Array.from(document.querySelectorAll('.tgw-modal .tgw-field-check input'))
            .find((input) => ((input.nextElementSibling && input.nextElementSibling.textContent) || '').includes('Jalali'));
        ok(!!jalaliToggle(), 'settings carry a Jalali (Solar Hijri) dates toggle');
        ok(!!jalaliToggle() && jalaliToggle().checked, 'Jalali dates start on for this user');

        // The user preference writes are counted from here on: the server-defaults check above
        // already persisted a copy, and that one must not satisfy the assertion below.
        const pluginPrefWrites = () => payloads.filter((entry) => entry.path === '/users/me/preferences'
            && Array.isArray(entry.body) && entry.body[0] && entry.body[0].category === 'com.telegramweb.ui');
        const prefsBefore = pluginPrefWrites().length;

        // Turn the calendar off: the setting flips immediately, the chat re-renders in Gregorian
        // dates, and the choice lands in localStorage + the Mattermost user preference.
        jalaliToggle()?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => getSettings().jalali === false);
        ok(getSettings().jalali === false, 'unchecking the toggle switches Jalali dates off');
        await waitFor(() => /202\d/.test(document.querySelector('.tgw-msg-time')?.textContent || ''));
        const gregorianStamp = document.querySelector('.tgw-msg-time')?.textContent || '';
        ok(/202\d/.test(gregorianStamp), `the chat falls back to Gregorian dates (${gregorianStamp})`);
        const gregorianChatTime = formatChatTime(fixture, fmt);
        ok(/^\d{2}\.(0[1-9]|1[0-2])\.23$/.test(gregorianChatTime),
            `formatChatTime renders the Gregorian dd.MM.yy again (${gregorianChatTime})`);
        const mirror = JSON.parse(dom.window.localStorage.getItem('tgw.settings.com.telegramweb.ui') || '{}');
        ok(mirror.jalali === false, 'the choice is mirrored in localStorage');
        const savedOff = () => pluginPrefWrites().slice(prefsBefore)
            .some((entry) => /"jalali":false/.test(String(entry.body[0].value)));
        await waitFor(savedOff, 3000);
        ok(savedOff(), 'the choice is saved as a Mattermost user preference');

        // And back on — the stamps must follow without a reload.
        jalaliToggle()?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => getSettings().jalali === true);
        ok(getSettings().jalali === true, 'checking the toggle switches Jalali dates back on');
        await waitFor(() => /1402/.test(document.querySelector('.tgw-msg-time')?.textContent || ''));
        ok(/1402/.test(document.querySelector('.tgw-msg-time')?.textContent || ''),
            'the stamps return to the Jalali calendar without a reload');

        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        await waitFor(() => !document.querySelector('.tgw-modal'));
        ok(!document.querySelector('.tgw-modal'), 'Escape closes the settings modal');
    }

    console.log('\n== url sync ==');
    // Leave search mode first so the normal chat list is back.
    document.querySelector('.tgw-search-clear')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await tick(30);
    const dmRow = Array.from(document.querySelectorAll('.tgw-chat-row')).find((row) => row.textContent.includes('Alice Anderson'));
    ok(!!dmRow, 'dm row found for the url sync check');
    if (dmRow) {
        dmRow.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await waitFor(() => document.querySelector('.tgw-chat-header-title')?.textContent === 'Alice Anderson (alley)');
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

    console.log('\n== newly opened direct chat ==');
    state.entities.users.profiles[ids.THIRD].last_picture_update = 42;
    document.querySelector('button[title="New chat"]')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await waitFor(() => document.querySelector('.tgw-menu'));
    Array.from(document.querySelectorAll('.tgw-menu-item')).find((item) => item.textContent.trim() === 'New Message')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await waitFor(() => document.querySelector('[role="dialog"][aria-label="New message"]'));
    const newPeer = Array.from(document.querySelectorAll('.tgw-modal .tgw-picker-row')).find((row) => row.textContent.includes('Nina Novak'));
    ok(!!newPeer, 'new message picker includes the contact');
    newPeer?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await waitFor(() => document.querySelector('.tgw-chat-header-title')?.textContent === 'Nina Novak');
    ok(document.querySelector('.tgw-chat-header-title')?.textContent === 'Nina Novak', 'new direct chat shows the contact name instead of the raw channel name');
    ok(document.querySelector('.tgw-chat-header-main .tgw-avatar img')?.getAttribute('src')?.includes('/users/user-third/image'), 'new direct chat shows the contact profile picture');
    ok(calls.some((call) => call === `GET /channels/${ids.NEW_DM}`), 'new channel is loaded when the host store has not received it yet');

    console.log('\n== own avatar menu ==');
    // Simulate Mattermost's own account menu so the test catches hosts where openUserSettings is
    // present but does not mount its modal from the plugin root.
    dom.window.__userSettingsOpens.length = 0;
    const hostAccountButton = document.createElement('button');
    hostAccountButton.id = 'userAccountMenuButton';
    hostAccountButton.addEventListener('click', () => {
        let hostMenu = document.getElementById('userAccountMenu');
        if (hostMenu) {
            hostMenu.remove();
            return;
        }
        hostMenu = document.createElement('div');
        hostMenu.id = 'userAccountMenu';
        hostMenu.setAttribute('role', 'menu');
        const hostProfileItem = document.createElement('button');
        hostProfileItem.setAttribute('role', 'menuitem');
        hostProfileItem.textContent = 'Profile';
        hostProfileItem.addEventListener('click', () => {
            const profileDialog = document.createElement('div');
            profileDialog.id = 'accountSettingsModal';
            profileDialog.textContent = 'Profile Settings';
            document.body.appendChild(profileDialog);
            hostMenu.remove();
        });
        hostMenu.appendChild(hostProfileItem);
        document.body.appendChild(hostMenu);
    });
    document.body.appendChild(hostAccountButton);
    document.querySelector('.tgw-user-button')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await waitFor(() => document.querySelector('.tgw-menu'));
    const profileSettingsItem = Array.from(document.querySelectorAll('.tgw-menu-item')).find((item) => item.textContent.includes('Profile settings'));
    ok(!!profileSettingsItem, 'pressing the own avatar offers Profile settings');
    if (profileSettingsItem) {
        profileSettingsItem.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await tick(30);
        ok(dom.window.__userSettingsOpens.length === 1, 'the host is asked to open its own profile popup');
        ok(JSON.stringify(dom.window.__userSettingsOpens[0]) === JSON.stringify({isContentProductSettings: false, activeTab: 'profile'}),
            'the popup lands on the profile tab (got: ' + JSON.stringify(dom.window.__userSettingsOpens[0]) + ')');
        await waitFor(() => document.getElementById('accountSettingsModal'));
        ok(!!document.getElementById('accountSettingsModal'), 'a no-op host helper falls back to Mattermost Profile Settings');
    }

    // Hosts without openUserSettings still reach the native profile dialog through the account menu.
    const realOpenUserSettings = dom.window.WebappUtils.openUserSettings;
    delete dom.window.WebappUtils.openUserSettings;
    document.getElementById('accountSettingsModal')?.remove();
    document.querySelector('.tgw-user-button')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await waitFor(() => document.querySelector('.tgw-menu'));
    Array.from(document.querySelectorAll('.tgw-menu-item')).find((item) => item.textContent.includes('Profile settings'))
        ?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await waitFor(() => document.getElementById('accountSettingsModal'));
    ok(!!document.getElementById('accountSettingsModal'), 'a host without the helper still opens native Profile Settings');

    // If neither host entry point is available, the menu reports the unavailable action.
    document.getElementById('accountSettingsModal')?.remove();
    hostAccountButton.remove();
    document.querySelector('.tgw-user-button')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await waitFor(() => document.querySelector('.tgw-menu'));
    Array.from(document.querySelectorAll('.tgw-menu-item')).find((item) => item.textContent.includes('Profile settings'))
        ?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    await tick(30);
    ok((document.querySelector('.tgw-toasts')?.textContent || '').includes('Profile settings are not available in this Mattermost version'),
        'a host without either entry point gets a clear message');
    dom.window.WebappUtils.openUserSettings = realOpenUserSettings;

    console.log('\n== stock UI view tracking ==');
    // A user on the stock Mattermost UI never scrolls our message list: opening a channel there
    // must still report its recent posts as seen through the plugin API. Turn the overlay off
    // and poke the host store the way the stock webapp would.
    updateSettings({mode: 'off'});
    const stockCallsBefore = calls.length;
    startStockUIViewTracking();
    notifyStoreChange();
    await waitFor(() => calls.slice(stockCallsBefore).some((call) => call === `GET /channels/${ids.DM}/posts`), 4000);
    ok(calls.slice(stockCallsBefore).some((call) => call === `GET /channels/${ids.DM}/posts`), 'opening a channel in the stock UI fetches its recent posts');

    // The regression behind "seen not reported when the other user is on Mattermost's own UI":
    // a message arriving in the channel the reader ALREADY has open never changes
    // currentChannelId, and that read is what the sender's double checkmark waits for.
    // Without a channel switch the bridge used to go silent until the next switch.
    pushStockPost({
        id: 'p-stock-new', create_at: Date.now(), update_at: Date.now(), edit_at: 0, delete_at: 0,
        user_id: ids.OTHER, channel_id: ids.DM, message: 'sent while the channel stayed open',
        type: '', props: {}, root_id: '', is_pinned: false,
    });
    notifyStoreChange();
    const lateSeen = await waitFor(() => viewTracking.get('p-stock-new') && viewTracking.get('p-stock-new').has(ids.ME), 4000);
    ok(!!lateSeen, 'a new post in the already-open stock channel is reported as seen without any channel switch');

    console.log('\n== leaving a group ==');
    await api.leaveChannel(ids.TOWN);
    ok(calls.some((call) => call === `DELETE /channels/${ids.TOWN}/members/me`), 'leaving a group uses the Mattermost membership endpoint');
    ok(!state.entities.channels.myMembers[ids.TOWN], 'leaving a group removes its current-user membership from the host store');
    ok(!require('../src/mm/selectors').getAllChats(state).some((chat) => chat.id === ids.TOWN), 'a left group disappears from the Telegram chat list');

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
