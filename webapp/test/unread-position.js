const {dom, React, ReactDOM, container, store, state, ids, tick, ok, report} = require('./harness');
const {setStore} = require('../src/mm/store');
const {TgContext} = require('../src/ui/context');
const {MessageList} = require('../src/ui/MessageList');
setStore(store);
const root = ReactDOM.createRoot(container);
const proto = dom.window.HTMLElement.prototype;
proto.getBoundingClientRect = function () {
    if (this.dataset.postId) {
        const list = this.closest('.tgw-messages');
        const index = Array.from(list.querySelectorAll('[data-post-id]')).indexOf(this);
        return {top: 20 + index * 100 - list.scrollTop, bottom: 100 + index * 100 - list.scrollTop};
    }
    return {top: 20, bottom: 220};
};
Object.defineProperty(proto, 'scrollHeight', {configurable: true, get: () => 1000});
Object.defineProperty(proto, 'clientHeight', {configurable: true, get: () => 200});
proto.scrollTo = function ({top}) { this.scrollTop = top; };
const channel = {...state.entities.channels.channels[ids.DM], total_msg_count: 8};
const posts = Array.from({length: 8}, (_, n) => ({id: `position-${n}`,channel_id:ids.DM,user_id:n===3?ids.ME:ids.OTHER,
    message:`Message ${n}`,create_at:(n+1)*1000,update_at:(n+1)*1000,delete_at:0,props:{}}));
const member = state.entities.channels.myMembers[ids.DM];
member.last_viewed_at = 3000; member.msg_count = 3;
const render = async (props = {}, key = 'unread') => {
    root.render(React.createElement(TgContext.Provider, {value:{me:state.entities.users.profiles[ids.ME],ui:{},actions:{setUI:()=>{}},settings:{},timeFormat:'24h'}},
        React.createElement(MessageList, {key,channel,posts,loading:false,loadingOlder:false,hasMoreOlder:false,...props})));
    await tick(80);
};
const list = () => document.querySelector('.tgw-messages');
(async () => {
    await render({posts:[],loading:false,hasMoreOlder:true});
    await render({posts:[],loading:true});
    member.last_viewed_at=9000; member.msg_count=8;
    await render();
    ok(list()?.scrollTop===360, 'opening waits for posts and lands at the first unread incoming message using the entry boundary');
    ok(document.querySelector('.tgw-unread-divider')?.nextElementSibling?.dataset.postId==='position-4','unread divider keeps its entry position after the view receipt');
    await render({posts:[...posts,{...posts[7],id:'position-8',create_at:10000}]});
    ok(list()?.scrollTop===360,'new incoming messages do not move the unread reading position');
    await render({},'read');
    ok(list()?.scrollTop===1000,'a chat with no unread messages opens at the bottom');
    member.last_viewed_at=3000; member.msg_count=3;
    let jumped=false;
    proto.scrollIntoView=function(){jumped=this.dataset.postId==='position-6';};
    await render({highlightedPostId:'position-6'},'highlight');
    ok(jumped,'an explicit post jump takes precedence over unread positioning');
    const postCache = require('../src/mm/posts');
    const originalLoadOlder = postCache.loadOlder;
    let olderRequested = 0;
    postCache.loadOlder = async () => { olderRequested++; };
    await render({posts:posts.slice(5),hasMoreOlder:true},'paged');
    ok(olderRequested > 0 && list()?.scrollTop!==1000,'an unread boundary outside the latest page requests older history before positioning');
    await render({posts,hasMoreOlder:false},'paged');
    ok(list()?.scrollTop===360,'after older history loads the chat lands at its unread boundary');
    postCache.loadOlder = originalLoadOlder;
    root.unmount();report('UNREAD POSITION TEST');
})().catch(error=>{console.error(error);root.unmount();process.exitCode=1;});
