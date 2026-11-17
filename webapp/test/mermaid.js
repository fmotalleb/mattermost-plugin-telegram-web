// Exercise both message formatting paths and modal controls without jsdom's missing SVG layout.
const {React, ReactDOM, container, tick, ok, report, dom} = require('./harness');
const renders = [];
let config;
require.cache[require.resolve('mermaid')] = {id: require.resolve('mermaid'), filename: require.resolve('mermaid'), loaded: true, exports: {
    __esModule: true,
    default: {
        initialize: (value) => { config = value; },
        render: async (id, source) => {
            renders.push({id, source});
            if (source === 'invalid') throw new Error('Invalid syntax');
            return {svg: `<svg id="${id}" viewBox="0 0 200 100"><text>diagram</text></svg>`};
        },
    },
}};
const {MessageBody} = require('../src/ui/render');
container.className = 'tgw-root';
const root = ReactDOM.createRoot(container);
const wait = async (predicate) => { for (let i = 0; i < 100 && !predicate(); i++) await tick(20); return predicate(); };
const click = (node) => node.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
(async () => {
    for (const host of [false, true]) {
        if (host) window.PostUtils = {
            formatText: (value) => value,
            messageHtmlToComponent: (value) => React.createElement('span', {'data-host': true}, value),
        };
        else delete window.PostUtils;
        root.render(React.createElement(MessageBody, {key: String(host), message: 'Before\n```mermaid\nflowchart LR\nA-->B\n```\nAfter'}));
        await tick(30);
        await wait(() => container.querySelector('.tgw-mermaid svg'));
        ok(!!container.querySelector('.tgw-mermaid svg') && container.textContent.includes('Before') && container.textContent.includes('After'), `${host ? 'host' : 'fallback'} renders Mermaid between surrounding text`);
        const button = container.querySelector('.tgw-mermaid-open');
        button.focus(); click(button);
        await wait(() => container.querySelector('.tgw-mermaid-modal svg'));
        ok(!!container.querySelector('[role="dialog"] svg') && document.activeElement.textContent === 'Close', 'modal renders its own SVG and takes keyboard focus');
        const svgIds = [...container.querySelectorAll('svg')].map((svg) => svg.id);
        ok(new Set(svgIds).size === svgIds.length, 'inline and modal diagrams have independent SVG ids');
        click(container.querySelector('[aria-label="Zoom in"]')); await tick(20);
        ok(container.querySelector('output').textContent === '120%', 'zoom in increases scale');
        click(container.querySelector('[aria-label="Zoom out"]')); await tick(20);
        ok(container.querySelector('output').textContent === '100%', 'zoom out decreases scale');
        click(container.querySelector('[aria-label="Zoom in"]')); await tick(20);
        click([...container.querySelectorAll('button')].find((node) => node.textContent === 'Reset view')); await tick(20);
        ok(container.querySelector('output').textContent === '100%', 'reset restores scale');
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); await tick(20);
        ok(!container.querySelector('[role="dialog"]') && document.activeElement === button, 'Escape closes the viewer and restores focus');
    }
    root.render(React.createElement(MessageBody, {message: '```mermaid\ninvalid\n```'}));
    await wait(() => container.querySelector('.tgw-mermaid-error'));
    ok(container.textContent.includes('Could not render') && container.querySelector('code').textContent === 'invalid', 'invalid diagrams retain readable source');
    root.render(React.createElement(MessageBody, {message: '````text\n```mermaid\nflowchart LR\nA-->B\n```\n````'})); await tick(30);
    ok(!container.querySelector('.tgw-mermaid'), 'Mermaid example nested inside another fence stays code');
    root.render(React.createElement(MessageBody, {message: '```js\nconst x = 1;\n```\n```mermaid\nunfinished'})); await tick(30);
    ok(!container.querySelector('.tgw-mermaid'), 'ordinary and incomplete fences stay code');
    root.render(React.createElement(MessageBody, {message: '~~~mermaid\r\nsequenceDiagram\r\nA->>B: Hi\r\n~~~'}));
    await tick(30);
    await wait(() => container.querySelector('.tgw-mermaid svg'));
    ok(renders.some(({source}) => source === 'sequenceDiagram\r\nA->>B: Hi'), 'tilde fences and CRLF are supported');
    root.render(React.createElement(MessageBody, {message: '```mermaid\nflowchart LR\nLong-->Fence\n`````'}));
    await tick(30);
    await wait(() => renders.some(({source}) => source.includes('Long-->Fence')));
    ok(renders.some(({source}) => source.includes('Long-->Fence')), 'closing fences may be longer than their opener');
    const toggles = [];
    window.PostUtils.messageHtmlToComponent = (value) => value.includes('[ ]') ? React.createElement('input', {type:'checkbox'}) : value;
    root.render(React.createElement(MessageBody, {message: '- [ ] Before\n```mermaid\nflowchart LR\nA-->B\n```\n- [ ] After', onTaskToggle:(...args)=>toggles.push(args)}));
    await tick(30);
    const boxes = container.querySelectorAll('input');
    click(boxes[1]); await tick(20);
    ok(toggles.length === 1 && toggles[0][0] === 1, 'task indices stay correct across diagram blocks');
    ok(config.securityLevel === 'strict' && config.startOnLoad === false && config.secure.includes('dompurifyConfig'), 'untrusted messages cannot weaken rendering security');
    const beforeLazy = renders.length;
    let reveal;
    global.IntersectionObserver = class {
        constructor(callback) { reveal = callback; }
        observe() {}
        disconnect() {}
    };
    delete window.PostUtils;
    root.render(React.createElement(MessageBody, {key:'lazy',message:'```mermaid\nflowchart LR\nLazy-->Visible\n```'}));await tick(40);
    ok(renders.length === beforeLazy, 'offscreen diagrams do not invoke the Mermaid renderer');
    reveal([{isIntersecting:true}]);
    await wait(()=>renders.some(({source})=>source.includes('Lazy-->Visible')));
    ok(renders.some(({source})=>source.includes('Lazy-->Visible')), 'revealing a diagram starts its deferred render');
    delete global.IntersectionObserver;
    root.unmount(); report('MERMAID TEST');
})().catch((error) => { console.error(error); root.unmount(); process.exitCode = 1; });
