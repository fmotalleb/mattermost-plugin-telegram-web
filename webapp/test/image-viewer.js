const {dom, React, ReactDOM, container, store, tick, ok, report, ids, posts, channels} = require('./harness');
const {setStore} = require('../src/mm/store');
const {TgContext} = require('../src/ui/context');
const {ImageViewer} = require('../src/ui/ImageViewer');
setStore(store);
container.className = 'tgw-root';
let canvasWidth = 800, canvasHeight = 600;
const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('tgw-image-viewer-viewport')) return {left:0,top:0,right:canvasWidth,bottom:canvasHeight,width:canvasWidth,height:canvasHeight};
    return originalRect.call(this);
};
function App() {
    const [target, setTarget] = React.useState(null);
    return React.createElement(TgContext.Provider, {value:{ui:{imageViewer:target},channel:channels[ids.DM],actions:{setUI:(patch)=>setTarget(patch.imageViewer)}}},
        React.createElement('button', {id:'open-image',onClick:()=>setTarget({post:posts.p1,fileId:'file-1'})}, 'Open image'),
        React.createElement(ImageViewer));
}
const root = ReactDOM.createRoot(container);
const wait = async (fn) => { for(let n=0;n<100&&!fn();n++) await tick(20); return fn(); };
const click = (node) => node?.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
const button = (text) => Array.from(document.querySelectorAll('.tgw-image-viewer button')).find((node)=>node.textContent===text);
const canvas = () => document.querySelector('.tgw-image-viewer-viewport');
const output = () => document.querySelector('.tgw-image-viewer output')?.textContent;
const transform = () => document.querySelector('.tgw-image-viewer-stage')?.style.transform;
const load = async (width=1600,height=1200) => {
    const image=document.querySelector('.tgw-image-viewer img');
    Object.defineProperties(image,{naturalWidth:{configurable:true,value:width},naturalHeight:{configurable:true,value:height}});
    image.dispatchEvent(new dom.window.Event('load',{bubbles:true}));await tick(30);
};
const pointer = (type,id,x,y) => {
    const event=new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y});
    Object.defineProperty(event,'pointerId',{value:id});canvas().dispatchEvent(event);
};
(async()=>{
    root.render(React.createElement(App));await tick(50);
    const opener=document.querySelector('#open-image');opener.focus();click(opener);
    await wait(()=>document.querySelector('.tgw-image-viewer img'));
    ok(document.querySelector('[role="dialog"][aria-label="Image viewer"]')&&document.activeElement.classList.contains('tgw-image-viewer-close'),'image viewer opens as a focused modal');
    await load();ok(output()==='50%','large image initially fits the available canvas');
    click(button('100%'));await tick(20);ok(output()==='100%','100% displays original image resolution');
    pointer('pointerdown',1,400,300);pointer('pointermove',1,500,350);pointer('pointerup',1,500,350);await tick(20);
    ok(transform().includes('100px')&&transform().includes('50px'),'dragging pans a zoomed image');
    click(button('Fit'));await tick(20);ok(output()==='50%'&&transform().includes('0px'),'Fit resets zoom and pan');
    const wheel=new dom.window.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-100,clientX:500,clientY:350});canvas().dispatchEvent(wheel);await tick(20);
    ok(wheel.defaultPrevented&&parseInt(output(),10)>50,'wheel zoom is handled inside the image canvas');
    click(button('Fit'));await tick(20);
    pointer('pointerdown',1,300,300);pointer('pointerdown',2,500,300);pointer('pointermove',2,600,300);pointer('pointerup',2,600,300);pointer('pointerup',1,300,300);await tick(20);
    ok(output()==='75%','two-finger pinch zooms the image');
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'0',bubbles:true}));await tick(20);
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'+',bubbles:true}));await tick(20);
    ok(parseInt(output(),10)>50,'keyboard zoom works while a viewer control has focus');
    for(let n=0;n<18;n++){click(document.querySelector('[aria-label="Zoom in"]'));await tick(5);}
    ok(output()==='800%'&&document.querySelector('[aria-label="Zoom in"]').disabled,'zoom has a bounded maximum');
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await tick(40);
    ok(document.querySelector('.tgw-image-viewer img').src.includes('file-2'),'arrow keys navigate between attachments');
    await load(600,1200);ok(output()==='50%'&&transform().includes('0px'),'navigation fits the next image and clears pan');
    ok(document.querySelector('[aria-label="Download image"]').href.includes('file-2'),'download follows the displayed image');
    canvasWidth=300;canvasHeight=500;window.dispatchEvent(new dom.window.Event('resize'));await tick(30);
    ok(output()==='42%','resizing refits the image to a mobile-sized canvas');
    document.querySelector('.tgw-image-viewer img').dispatchEvent(new dom.window.Event('error'));await tick(20);
    ok(document.querySelector('.tgw-image-viewer [role="alert"]')?.textContent.includes('Could not load'),'failed images show a recoverable error');
    click(button('Retry'));await load(600,1200);ok(!document.querySelector('.tgw-image-viewer [role="alert"]'),'retry can recover a failed image');
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
    ok(document.querySelector('.tgw-image-viewer').contains(document.activeElement),'Tab stays inside the viewer');
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick(30);
    ok(!document.querySelector('.tgw-image-viewer')&&document.activeElement===opener,'Escape closes the viewer and restores focus');
    root.unmount();dom.window.HTMLElement.prototype.getBoundingClientRect=originalRect;report('IMAGE VIEWER TEST');
})().catch((error)=>{console.error(error);root.unmount();process.exitCode=1;});
