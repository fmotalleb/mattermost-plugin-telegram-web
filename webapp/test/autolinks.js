const {React, ReactDOM, container, store, tick, ok, report} = require('./harness');
const {setStore} = require('../src/mm/store');
const {MessageBody} = require('../src/ui/render');
setStore(store);
const root = ReactDOM.createRoot(container);
const originalPostUtils = window.PostUtils;
const wait = async (predicate) => { for (let i = 0; i < 80 && !predicate(); i++) await tick(25); return predicate(); };
(async () => {
    const text = 'kmp-api-access.dornica.chat service.cloud/a?room=2 example.com.au x.ch example.chat. x.company x.chatty bob@example.com `code.chat` [label](https://example.org)';
    for (const host of [false, true]) {
        if (host) {
            window.PostUtils = {
                formatText: (value) => value,
                messageHtmlToComponent: () => React.createElement('span', {'data-host-links': 'yes'},
                    'kmp-api-access.dornica.chat service.cloud/a?room=2 example.com.au x.ch example.chat. x.company x.chatty bob@example.com ',
                    React.createElement('code', null, 'code.chat'), ' ',
                    React.createElement('a', {href:'https://example.org'}, 'label')),
            };
        } else delete window.PostUtils;
        root.render(React.createElement(MessageBody, {key:String(host), message:text}));
        await wait(() => host ? container.querySelector('[data-host-links] a') : container.querySelector('a'));
        const links = Array.from(container.querySelectorAll('a'));
        const has = (value, href = `https://${value}`) => links.some((node) => node.textContent === value && node.getAttribute('href') === href);
        const path = host ? 'host renderer' : 'fallback renderer';
        ok(has('kmp-api-access.dornica.chat'), `${path} links the complete .chat domain`);
        ok(has('service.cloud/a?room=2') && has('example.com.au'), `${path} preserves longer suffixes, paths and query strings`);
        ok(has('x.ch') && has('example.chat'), `${path} supports .ch and excludes trailing sentence punctuation`);
        ok(!links.some((node) => ['x.co', 'x.com', 'x.company', 'x.chat', 'x.chatty', 'example.com', 'code.chat'].includes(node.textContent)), `${path} avoids partial suffixes, emails and code`);
        ok(has('label', 'https://example.org') && links.length === 6, `${path} preserves existing links without nesting anchors`);
    }
    window.PostUtils = originalPostUtils;
    root.unmount();
    report('AUTOLINK TEST');
})().catch((error) => { window.PostUtils = originalPostUtils; console.error(error); root.unmount(); process.exitCode = 1; });
