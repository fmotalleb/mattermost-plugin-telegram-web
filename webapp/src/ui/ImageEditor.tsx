import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';

type Point = {x: number; y: number};
type Rect = Point & {width: number; height: number};
type Tool = 'Pen' | 'Marker' | 'Crop' | 'Resize';
// Crop and strokes use source pixels so transforms can be undone without resampling.
type Stroke = {points: Point[]; color: string; width: number; opacity: number};
type Edit = {crop: Rect; turns: number; width: number; height: number; strokes: Stroke[]};
type History = {past: Edit[]; current: Edit; future: Edit[]};
type Gesture = {id: number; start: Point; stroke?: Stroke};

const MAX_EDGE = 8192;
const MAX_PIXELS = 32_000_000;
const tools: Tool[] = ['Pen', 'Marker', 'Crop', 'Resize'];

function imageTransform(edit: Edit, width: number, height: number) {
    const {crop, turns} = edit;
    const sideways = turns % 2 === 1;
    return new DOMMatrix().translate(width / 2, height / 2)
        .scale(width / (sideways ? crop.height : crop.width), height / (sideways ? crop.width : crop.height))
        .rotate(turns * 90)
        .translate(-crop.x - crop.width / 2, -crop.y - crop.height / 2);
}

function paint(canvas: HTMLCanvasElement, source: HTMLImageElement, edit: Edit, draft?: Stroke) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is unavailable');
    ctx.resetTransform();
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(imageTransform(edit, canvas.width, canvas.height));
    const {crop} = edit;
    ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, crop.x, crop.y, crop.width, crop.height);
    for (const {points, color, width, opacity} of draft ? [...edit.strokes, draft] : edit.strokes) {
        const [first] = points;
        ctx.globalAlpha = opacity;
        ctx.beginPath();
        if (points.length === 1) {
            ctx.fillStyle = color;
            ctx.arc(first.x, first.y, width / 2, 0, 2 * Math.PI);
            ctx.fill();
        } else {
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.moveTo(first.x, first.y);
            for (const point of points) ctx.lineTo(point.x, point.y);
            ctx.stroke();
        }
    }
}

function selectedRect(start: Point, end: Point): Rect {
    return {x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y)};
}

interface ImageEditorProps {
    source: HTMLImageElement;
    name: string;
    onApply?: (file: File) => void;
    onSend?: (file: File) => void;
}

export function ImageEditor({source, name, onApply, onSend}: ImageEditorProps) {
    const [history, setHistory] = useState<History>(() => {
        const {naturalWidth: width, naturalHeight: height} = source;
        return {past: [], current: {crop: {x: 0, y: 0, width, height}, turns: 0, width, height, strokes: []}, future: []};
    });
    const {current: edit, past, future} = history;
    const [tool, setTool] = useState<Tool>('Pen');
    const [brushes, setBrushes] = useState({Pen: {color: '#ff3b50', width: 4}, Marker: {color: '#ffdf40', width: 20}});
    const brush = tool === 'Pen' || tool === 'Marker' ? brushes[tool] : null;
    const [selection, setSelection] = useState<Rect | null>(null);
    const [dimensions, setDimensions] = useState({width: String(edit.width), height: String(edit.height)});
    const [lockAspect, setLockAspect] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const canvas = useRef<HTMLCanvasElement>(null);
    const gesture = useRef<Gesture | null>(null);
    const frame = useRef<number | null>(null);
    const mounted = useRef(false);
    const scale = 1200 / Math.max(edit.width, edit.height);
    const width = Math.max(1, Math.round(edit.width * scale));
    const height = Math.max(1, Math.round(edit.height * scale));

    const cancelFrame = () => {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
    };
    const redraw = () => {
        cancelFrame();
        if (!canvas.current) return;
        try {
            paint(canvas.current, source, edit, gesture.current?.stroke);
        } catch {
            setError('Could not draw this image in the editor.');
        }
    };
    useLayoutEffect(redraw, [edit]);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; cancelFrame(); };
    }, []);

    const clearGesture = () => {
        const active = gesture.current;
        gesture.current = null;
        if (active && canvas.current?.hasPointerCapture(active.id)) canvas.current.releasePointerCapture(active.id);
        setSelection(null);
    };
    const show = (next: History) => {
        clearGesture();
        setError('');
        setDimensions({width: String(next.current.width), height: String(next.current.height)});
        setHistory(next);
    };
    const commit = (next: Edit) => show({past: [...past, edit], current: next, future: []});

    const pointAt = (event: React.PointerEvent<HTMLCanvasElement>, clamp: boolean) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / bounds.width * width;
        const y = (event.clientY - bounds.top) / bounds.height * height;
        return clamp ? {x: Math.max(0, Math.min(width, x)), y: Math.max(0, Math.min(height, y))} : {x, y};
    };
    const sourcePoint = (point: Point) => imageTransform(edit, width, height).inverse().transformPoint(point);
    const cropImage = () => {
        if (!selection?.width || !selection.height) return;
        const start = sourcePoint(selection);
        const end = sourcePoint({x: selection.x + selection.width, y: selection.y + selection.height});
        const a = {x: Math.round(start.x), y: Math.round(start.y)};
        const b = {x: Math.round(end.x), y: Math.round(end.y)};
        const crop = selectedRect(a, b);
        if (!crop.width || !crop.height) {
            setError('Select a larger area to crop.');
            return;
        }
        const sideways = edit.turns % 2 === 1;
        commit({...edit, crop,
            width: Math.max(1, Math.round(edit.width * (sideways ? crop.height / edit.crop.height : crop.width / edit.crop.width))),
            height: Math.max(1, Math.round(edit.height * (sideways ? crop.width / edit.crop.width : crop.height / edit.crop.height))),
        });
    };
    const changeDimension = (axis: 'width' | 'height', value: string) => {
        const other = axis === 'width' ? 'height' : 'width';
        const linked = value ? String(Math.max(1, Math.round(Number(value) * edit[other] / edit[axis]))) : '';
        setDimensions({...dimensions, [axis]: value, [other]: lockAspect ? linked : dimensions[other]});
    };
    const resize = (event: React.FormEvent) => {
        event.preventDefault();
        const width = Number(dimensions.width);
        const height = Number(dimensions.height);
        if (!validSize(width, height)) {
            setError('Enter positive whole dimensions up to 8,192 px per side and 32 megapixels total.');
            return;
        }
        commit({...edit, width, height});
    };
    const exportImage = (useFile?: (file: File) => void) => {
        if (!validSize(edit.width, edit.height)) {
            setTool('Resize');
            setError('Resize to 8,192 px per side and 32 megapixels total or smaller.');
            return;
        }
        setSaving(true);
        setError('');
        const failed = () => {
            setSaving(false);
            setError('Could not export the edited image. The original is available in the preview.');
        };
        try {
            const output = document.createElement('canvas');
            output.width = edit.width;
            output.height = edit.height;
            paint(output, source, edit);
            output.toBlob((blob) => {
                if (!mounted.current) return;
                if (!blob) { failed(); return; }
                const filename = `${name.replace(/\.[^.]+$/, '') || 'image'}-edited.png`;
                setSaving(false);
                if (useFile) {
                    useFile(new File([blob], filename, {type: blob.type}));
                    return;
                }
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                link.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
            }, 'image/png');
        } catch {
            failed();
        }
    };

    return <div className="tgw-image-editor">
        <div className="tgw-image-viewer-tools" role="group" aria-label="Image editing tools">
            {tools.map((value) => <button key={value} type="button" aria-pressed={tool === value} onClick={() => {
                clearGesture();
                redraw();
                setError('');
                setTool(value);
            }}>{value}</button>)}
            <button type="button" onClick={() => commit({...edit, turns: (edit.turns + 1) % 4, width: edit.height, height: edit.width})} title="Rotate 90° clockwise">Rotate ↻</button>
            <button type="button" disabled={!past.length} onClick={() => show({past: past.slice(0, -1), current: past[past.length - 1], future: [edit, ...future]})}>Undo</button>
            <button type="button" disabled={!future.length} onClick={() => show({past: [...past, edit], current: future[0], future: future.slice(1)})}>Redo</button>
        </div>
        {brush && <div className="tgw-image-viewer-tools">
            <label>Color <input type="color" value={brush.color} onChange={(event) => setBrushes({...brushes, [tool]: {...brush, color: event.currentTarget.value}})}/></label>
            <label>Brush size <input type="range" min="1" max="50" value={brush.width} onChange={(event) => setBrushes({...brushes, [tool]: {...brush, width: Number(event.currentTarget.value)}})}/></label>
        </div>}
        {tool === 'Crop' && <div className="tgw-image-viewer-tools">
            <span>Drag to select an area.</span>
            <button type="button" disabled={!selection?.width || !selection.height} onClick={cropImage}>Apply crop</button>
        </div>}
        {tool === 'Resize' && <form className="tgw-image-viewer-tools" onSubmit={resize}>
            <label>Width (px) <input type="number" min="1" step="1" required value={dimensions.width} onChange={(event) => changeDimension('width', event.currentTarget.value)}/></label>
            <label>Height (px) <input type="number" min="1" step="1" required value={dimensions.height} onChange={(event) => changeDimension('height', event.currentTarget.value)}/></label>
            <label><input type="checkbox" checked={lockAspect} onChange={(event) => setLockAspect(event.currentTarget.checked)}/> Keep aspect ratio</label>
            <button type="submit">Apply size</button>
        </form>}
        <div className="tgw-image-editor-viewport">
            <div className="tgw-image-editor-stage" style={{width: `min(100%, ${width / height * 100}cqh)`, aspectRatio: `${width} / ${height}`}}>
                <canvas ref={canvas} width={width} height={height} aria-label={name || 'Image attachment'} data-tool={tool}
                    onPointerDown={(event) => {
                        if (event.button !== 0 || gesture.current || (!brush && tool !== 'Crop')) return;
                        event.preventDefault();
                        const start = pointAt(event, !brush);
                        gesture.current = {id: event.pointerId, start};
                        event.currentTarget.setPointerCapture(event.pointerId);
                        if (brush) {
                            const sourceWidth = edit.turns % 2 ? edit.crop.height : edit.crop.width;
                            gesture.current.stroke = {points: [sourcePoint(start)], color: brush.color,
                                width: brush.width * sourceWidth / event.currentTarget.getBoundingClientRect().width,
                                opacity: tool === 'Marker' ? 0.32 : 1};
                            redraw();
                        } else {
                            setSelection(null);
                        }
                    }}
                    onPointerMove={(event) => {
                        const active = gesture.current;
                        if (active?.id !== event.pointerId) return;
                        const point = pointAt(event, !active.stroke);
                        if (active.stroke) {
                            active.stroke.points.push(sourcePoint(point));
                            if (frame.current === null) frame.current = requestAnimationFrame(redraw);
                        } else {
                            setSelection(selectedRect(active.start, point));
                        }
                    }}
                    onPointerUp={(event) => {
                        const active = gesture.current;
                        if (active?.id !== event.pointerId) return;
                        gesture.current = null;
                        const point = pointAt(event, !active.stroke);
                        if (active.stroke) {
                            if (active.stroke.points.length > 1 || point.x !== active.start.x || point.y !== active.start.y) active.stroke.points.push(sourcePoint(point));
                            commit({...edit, strokes: [...edit.strokes, active.stroke]});
                        } else {
                            setSelection(selectedRect(active.start, point));
                        }
                    }}
                    onLostPointerCapture={(event) => {
                        if (gesture.current?.id !== event.pointerId) return;
                        clearGesture();
                        redraw();
                    }}
                />
                {selection?.width > 0 && selection?.height > 0 && <div className="tgw-image-editor-selection" aria-hidden="true" style={{
                    left: `${selection.x / width * 100}%`, top: `${selection.y / height * 100}%`,
                    width: `${selection.width / width * 100}%`, height: `${selection.height / height * 100}%`,
                }}/>}
            </div>
        </div>
        {error && <div className="tgw-image-editor-error" role="alert">{error}</div>}
        <div className="tgw-image-viewer-tools">
            <output aria-label="Image dimensions">{edit.width} × {edit.height} px</output>
            {onApply ? <>
                <button type="button" className="tgw-image-editor-primary" disabled={saving || !past.length} onClick={() => exportImage(onApply)}>Apply edits</button>
                <button type="button" disabled={saving || !past.length || !onSend} onClick={() => exportImage(onSend)}>Send edited</button>
            </> :
                <button type="button" className="tgw-image-editor-primary" disabled={saving} onClick={() => exportImage()}>{saving ? 'Preparing download…' : 'Download PNG'}</button>}
        </div>
    </div>;
}

function validSize(width: number, height: number) {
    return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
        width <= MAX_EDGE && height <= MAX_EDGE && width * height <= MAX_PIXELS;
}
