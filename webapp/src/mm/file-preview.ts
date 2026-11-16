import type {MMFileInfo} from './types';

/** Markup and source files are displayed literally, never executed. */
export function filePreviewKind(file: MMFileInfo): 'pdf' | 'text' | null {
    const mime = (file.mime_type || '').split(';')[0].trim().toLowerCase();
    const name = (file.name || '').toLowerCase();
    if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
    if (mime.startsWith('text/') || /^application\/(json|ld\+json|xml|javascript|x-yaml|yaml|toml)$/.test(mime) ||
        /\.(txt|text|log|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|toml|ini|conf|cfg|env|js|jsx|ts|tsx|css|html|htm|svg|sh|sql|go|py|rs|rb|java|c|cpp|h)$/i.test(name)) return 'text';
    return null;
}
