import React, {useState} from 'react';
import {createPortal} from 'react-dom';
import {getSettings, setEnabled, subscribeSettings} from '../mm/settings';
import {deferred} from './deferred';

const TelegramView = deferred(() => import(/* webpackChunkName: "telegram-ui" */ './bootstrap').then((module) => module.TelegramUI), 'Telegram view', (failed, retry, reload) => createPortal(
    <div role={failed ? 'alert' : 'status'} style={{position: 'fixed', inset: 0, zIndex: 400, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: 'var(--center-channel-bg, #17212b)', color: 'var(--center-channel-color, #fff)'}}>
        <span>{failed ? 'Could not load the Telegram view.' : 'Loading Telegram view…'}</span>
        {failed && <button type="button" onClick={retry}>Retry</button>}
        {reload && <button type="button" onClick={reload}>Reload Mattermost</button>}
        <button type="button" onClick={() => setEnabled(false)}>Back to Mattermost</button>
    </div>, document.body,
));

export function LazyRoot() {
    const [enabled, setActive] = useState(() => getSettings().mode === 'on');
    React.useLayoutEffect(() => {
        const sync = () => setActive(getSettings().mode === 'on');
        const unsubscribe = subscribeSettings(sync);
        sync();
        return unsubscribe;
    }, []);
    return enabled ? <TelegramView deferredCancel={() => setEnabled(false)}/> : null;
}
