const {React, ReactDOM, container, store, tick, ok, report} = require('./harness');
const {setStore} = require('../src/mm/store');
const {safeLinkURL, safeImageURL} = require('../src/mm/urls');
const {MessageBody} = require('../src/ui/render');
const {PostAttachments} = require('../src/ui/MessageList');
setStore(store);
const root = ReactDOM.createRoot(container);
async function render(node) { root.render(node); await tick(50); }
(async () => {
    for (const url of ['javascript:alert`1`', 'JaVaScRiPt:alert`1`', 'java\nscript:alert`1`', 'data:text/html,<script>alert`1`</script>', 'vbscript:msgbox', 'file:///tmp/test', '//user:secret@outside.example/']) {
        ok(!safeLinkURL(url), `rejects untrusted scheme or credentials: ${JSON.stringify(url)}`);
    }
    ok(safeLinkURL('https://example.org/a') && safeLinkURL('/team/channels/town') && safeLinkURL('mailto:person@example.org'), 'ordinary links retain supported schemes');
    ok(!safeImageURL('mailto:person@example.org') && !safeImageURL('data:image/svg+xml,<svg/>'), 'images reject non-HTTP schemes');
    delete window.PostUtils;
    await render(React.createElement(MessageBody, {message: '[unsafe](javascript:alert`1`) [safe](https://example.org)'}));
    const links = [...container.querySelectorAll('a')];
    ok(!links.find((link) => link.textContent === 'unsafe')?.hasAttribute('href') && links.find((link) => link.textContent === 'safe')?.getAttribute('href') === 'https://example.org', 'fallback Markdown validates links independently of React protection');
    const attachment = {author_name:'Unsafe author', author_link:'javascript:alert`1`', title:'Unsafe title', title_link:'data:text/html,attack', image_url:'https://tracking.example/pixel'};
    await render(React.createElement(PostAttachments, {attachments:[attachment]}));
    ok([...container.querySelectorAll('a')].every((node) => !node.hasAttribute('href')), 'attachment author and title reject unsafe schemes');
    ok(!container.querySelector('img') && container.textContent.includes('Load external image'), 'external attachment image makes no automatic request');
    container.querySelector('button').click(); await tick(30);
    ok(container.querySelector('img')?.src === attachment.image_url && container.querySelector('img')?.getAttribute('referrerpolicy') === 'no-referrer', 'explicit external image choice suppresses referrers');
    await render(React.createElement(PostAttachments, {attachments:[{image_url:'https://another.example/image.png'}]}));
    ok(!container.querySelector('img'), 'image permission applies to the exact URL and cannot carry to a changed attachment');
    await render(React.createElement(PostAttachments, {attachments:[{image_url:'/api/v4/files/attachment/preview'}]}));
    ok(container.querySelector('img')?.src === 'https://mattermost.example.com/api/v4/files/attachment/preview', 'same-origin attachment images display without an external request');
    await render(React.createElement(PostAttachments, {attachments:[{image_url:'data:image/svg+xml,<svg onload=attack() />'}]}));
    ok(!container.querySelector('img') && !container.querySelector('button'), 'unsafe image schemes cannot be enabled');
    root.unmount(); report('SECURITY TEST');
})().catch((error) => { console.error(error); root.unmount(); process.exitCode = 1; });
