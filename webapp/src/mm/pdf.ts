import {version} from 'pdfjs-dist/package.json';
import {PLUGIN_ID} from './settings';

type PDFJS = typeof import('pdfjs-dist');
let pending: Promise<PDFJS> | undefined;
let failures = 0;

export function pdfAssetURL(file = ''): string {
    const basename = typeof (window as any).basename === 'string' ? (window as any).basename : '';
    return `${basename}/plugins/${PLUGIN_ID}/public/pdfjs/${version}/${file}`;
}

/** The import stays native and outside webpack's chunks. */
export function loadPDFJS(): Promise<PDFJS> {
    if (!pending) {
        const url = pdfAssetURL('pdf.min.mjs') + (failures ? `?retry=${failures}` : '');
        pending = import(/* webpackIgnore: true */ url).then((pdfjs: PDFJS) => {
            pdfjs.GlobalWorkerOptions.workerSrc = pdfAssetURL('pdf.worker.min.mjs');
            return pdfjs;
        }).catch(() => {
            failures++;
            pending = undefined;
            throw new Error('Could not load the PDF viewer. Please retry.');
        });
    }
    return pending;
}
