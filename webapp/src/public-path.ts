import {PLUGIN_ID} from './mm/settings';

declare let __webpack_public_path__: string;
// This module must run before imports that can request chunks or font assets.
const basename = typeof (window as any).basename === 'string' ? (window as any).basename.replace(/\/$/, '') : '';
__webpack_public_path__ = `${basename}/plugins/${PLUGIN_ID}/`;
