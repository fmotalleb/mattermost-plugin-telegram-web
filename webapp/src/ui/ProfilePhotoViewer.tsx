import React, {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {useTg} from './context';
import {overlayRoot} from './portal';
import {IconClose} from './primitives';

export function ProfilePhotoViewer() {
    const {ui, actions} = useTg();
    const photo = ui.profilePhoto;
    const closeButton = useRef<HTMLButtonElement>(null);
    const dialog = useRef<HTMLDivElement>(null);
    const [failed, setFailed] = useState(false);
    const latestClose = useRef(() => actions.setUI({profilePhoto: undefined}));
    latestClose.current = () => actions.setUI({profilePhoto: undefined});
    useEffect(() => {
        const previous = photo?.origin || document.activeElement as HTMLElement | null;
        closeButton.current?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                // Close only this viewer, leaving a profile card or quick chat underneath open.
                event.preventDefault();
                event.stopImmediatePropagation();
                latestClose.current();
            } else if (event.key === 'Tab') {
                event.preventDefault();
                event.stopImmediatePropagation();
                closeButton.current?.focus();
            }
        };
        const onFocus = (event: FocusEvent) => {
            if (!dialog.current?.contains(event.target as Node)) closeButton.current?.focus();
        };
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('focusin', onFocus);
        return () => {
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('focusin', onFocus);
            if (previous?.isConnected) previous.focus({preventScroll: true});
        };
    }, []);
    if (!photo) return null;
    return createPortal(<div ref={dialog} className="tgw-image-viewer tgw-profile-photo-viewer" role="dialog" aria-modal="true" aria-label={`${photo.name}'s profile photo`}
        onMouseDown={(event) => { if (event.target === event.currentTarget) latestClose.current(); }}>
        <button ref={closeButton} type="button" className="tgw-image-viewer-close" title="Close profile photo" aria-label="Close profile photo" onClick={() => latestClose.current()}><IconClose size={24}/></button>
        <div className="tgw-image-viewer-body">
            {failed ? <p role="alert" className="tgw-image-viewer-caption">Could not load this profile photo.</p>
                : <img className="tgw-profile-photo" src={photo.url} alt={`${photo.name}'s profile photo`} onError={() => setFailed(true)}/>}
            <div className="tgw-image-viewer-caption">{photo.name}</div>
        </div>
    </div>, overlayRoot());
}
