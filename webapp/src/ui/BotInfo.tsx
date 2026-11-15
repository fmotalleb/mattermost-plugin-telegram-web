import React, {useEffect, useState} from 'react';
import {api} from '../mm/api';
import type {MMBot, MMUser} from '../mm/types';

export function isBot(user?: MMUser) {
    return !!(user?.is_bot || user?.bot);
}

export function BotInfo({user}: {user: MMUser}) {
    const [bot, setBot] = useState<MMBot | null>(null);
    useEffect(() => {
        let cancelled = false;
        setBot(null);
        api.getBot(user.id).then((result) => { if (!cancelled) setBot(result); }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [user.id]);
    const details = bot?.user_id === user.id ? bot : null;
    return <div className="tgw-info-block tgw-bot-info">
        <div className="tgw-info-block-title">Bot info</div>
        <div className="tgw-info-text">{details?.display_name || user.first_name || user.username} · @{user.username}</div>
        {details?.description && <div className="tgw-info-text">{details.description}</div>}
        <div className="tgw-info-text">This is an automated account. Type / in the message box to see available team commands.</div>
    </div>;
}
