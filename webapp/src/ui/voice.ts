// Voice message recording: getUserMedia + MediaRecorder with a live level meter for the waveform.
//
// The hook owns the microphone stream, the recorder and the analyser; the Composer only renders
// the state it exposes and hands the finished take to the normal upload path. Every media API is
// behind a feature check, so a browser (or jsdom) without them gets a toast instead of a crash.

import {useCallback, useEffect, useRef, useState} from 'react';

export interface VoiceTake {
    file: File;
    durationMs: number;
    /** Normalised 0..1 levels sampled while recording, used for the waveform. */
    levels: number[];
}

export interface VoiceTakeMeta {
    durationMs: number;
    levels: number[];
}

export type VoiceStatus = 'idle' | 'recording';

/** Like Telegram, a take stops by itself after this long. */
export const VOICE_MAX_MS = 5 * 60 * 1000;

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];

export function pickVoiceMime(): string | undefined {
    const Recorder = window.MediaRecorder;
    if (!Recorder) {
        return undefined;
    }
    for (const mime of MIME_CANDIDATES) {
        try {
            if (!Recorder.isTypeSupported || Recorder.isTypeSupported(mime)) {
                return mime;
            }
        } catch {
            // isTypeSupported is allowed to throw on nonsense input; try the next candidate.
        }
    }
    return undefined;
}

export function voiceFileName(mime: string): string {
    const value = (mime || '').toLowerCase();
    const extension = value.includes('ogg') ? 'ogg' : value.includes('mp4') ? 'm4a' : value.includes('mpeg') ? 'mp3' : 'webm';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `voice-message-${stamp}.${extension}`;
}

/** Bucket the raw meter samples down to at most 64 bars and scale them to 0..1. */
function normaliseLevels(raw: number[]): number[] {
    if (!raw.length) {
        return [];
    }
    const bars = Math.min(64, raw.length);
    const buckets: number[] = [];
    for (let index = 0; index < bars; index++) {
        const start = Math.floor((index * raw.length) / bars);
        const end = Math.max(start + 1, Math.floor(((index + 1) * raw.length) / bars));
        let sum = 0;
        for (let cursor = start; cursor < end; cursor++) {
            sum += raw[cursor];
        }
        buckets.push(sum / (end - start));
    }
    const max = Math.max(...buckets, 0.0001);
    return buckets.map((value) => Math.min(1, Math.max(0.08, value / max)));
}

export function voiceSupported(): boolean {
    return !!navigator.mediaDevices?.getUserMedia && typeof window.MediaRecorder !== 'undefined';
}

export function useVoiceRecorder(onError?: (message: string) => void) {
    const [status, setStatus] = useState<VoiceStatus>('idle');
    const [durationMs, setDurationMs] = useState(0);
    const [levels, setLevels] = useState<number[]>([]);

    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;

    const streamRef = useRef<MediaStream | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const rawLevelsRef = useRef<number[]>([]);
    const startedAtRef = useRef(0);
    const cancelledRef = useRef(false);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const meterRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const resolveRef = useRef<((take: VoiceTake | null) => void) | null>(null);
    const finishRef = useRef<(() => Promise<VoiceTake | null>) | null>(null);

    const teardown = useCallback(() => {
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
        if (meterRef.current) {
            clearInterval(meterRef.current);
            meterRef.current = null;
        }
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        analyserRef.current = null;
        const context = audioCtxRef.current;
        audioCtxRef.current = null;
        if (context) {
            try {
                void context.close();
            } catch {
                // The context may already be closed; nothing to release then.
            }
        }
    }, []);

    const finish = useCallback((): Promise<VoiceTake | null> => {
        const recorder = recorderRef.current;
        if (!recorder || recorder.state === 'inactive') {
            teardown();
            setStatus('idle');
            setDurationMs(0);
            return Promise.resolve(null);
        }
        return new Promise<VoiceTake | null>((resolve) => {
            resolveRef.current = resolve;
            try {
                recorder.stop();
            } catch {
                resolveRef.current = null;
                recorderRef.current = null;
                teardown();
                setStatus('idle');
                setDurationMs(0);
                resolve(null);
            }
        });
    }, [teardown]);
    finishRef.current = finish;

    const cancel = useCallback(() => {
        cancelledRef.current = true;
        return finish();
    }, [finish]);

    const start = useCallback(async (): Promise<boolean> => {
        if (recorderRef.current) {
            return false;
        }
        if (!voiceSupported()) {
            onErrorRef.current?.('Voice recording is not supported in this browser');
            return false;
        }
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({audio: true});
        } catch {
            onErrorRef.current?.('Microphone access denied');
            return false;
        }

        const mime = pickVoiceMime();
        let recorder: MediaRecorder;
        try {
            recorder = mime ? new MediaRecorder(stream, {mimeType: mime}) : new MediaRecorder(stream);
        } catch {
            stream.getTracks().forEach((track) => track.stop());
            onErrorRef.current?.('Could not start the microphone');
            return false;
        }

        chunksRef.current = [];
        rawLevelsRef.current = [];
        cancelledRef.current = false;
        streamRef.current = stream;
        recorderRef.current = recorder;
        startedAtRef.current = Date.now();
        setStatus('recording');
        setDurationMs(0);
        setLevels([]);

        const handleStop = () => {
            const elapsed = Math.max(0, Date.now() - startedAtRef.current);
            const chunks = chunksRef.current;
            const raw = rawLevelsRef.current;
            const cancelled = cancelledRef.current;
            const type = (recorder.mimeType || mime || 'audio/webm').split(';')[0];
            const resolve = resolveRef.current;
            resolveRef.current = null;
            recorderRef.current = null;
            chunksRef.current = [];
            rawLevelsRef.current = [];
            teardown();
            setStatus('idle');
            setDurationMs(0);
            setLevels([]);
            if (cancelled || !chunks.length) {
                resolve?.(null);
                return;
            }
            resolve?.({file: new File(chunks, voiceFileName(type), {type}), durationMs: elapsed, levels: normaliseLevels(raw)});
        };

        recorder.ondataavailable = (event) => {
            if (event.data && event.data.size) {
                chunksRef.current.push(event.data);
            }
        };
        recorder.onstop = handleStop;
        recorder.onerror = () => {
            // Treat a recorder failure like a cancellation; finish() resolves the pending take.
            cancelledRef.current = true;
            void finishRef.current?.();
        };

        // A live level meter for the waveform; purely optional, the timer works without it.
        const Context = window.AudioContext || (window as typeof window & {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
        if (Context) {
            try {
                const context = new Context();
                audioCtxRef.current = context;
                const source = context.createMediaStreamSource(stream);
                const analyser = context.createAnalyser();
                analyser.fftSize = 256;
                source.connect(analyser);
                analyserRef.current = analyser;
                const samples = new Uint8Array(analyser.fftSize);
                meterRef.current = setInterval(() => {
                    const node = analyserRef.current;
                    if (!node) {
                        return;
                    }
                    node.getByteTimeDomainData(samples);
                    let sum = 0;
                    for (let index = 0; index < samples.length; index++) {
                        const value = (samples[index] - 128) / 128;
                        sum += value * value;
                    }
                    const rms = Math.sqrt(sum / samples.length);
                    rawLevelsRef.current.push(rms);
                    setLevels((current) => [...current.slice(-47), rms]);
                }, 100);
            } catch {
                // No meter: the recording still works, the live waveform just stays flat.
            }
        }

        timerRef.current = setInterval(() => {
            const elapsed = Date.now() - startedAtRef.current;
            setDurationMs(elapsed);
            if (elapsed >= VOICE_MAX_MS) {
                void finishRef.current?.();
            }
        }, 100);

        try {
            recorder.start();
        } catch {
            recorderRef.current = null;
            teardown();
            setStatus('idle');
            onErrorRef.current?.('Could not start the microphone');
            return false;
        }
        return true;
    }, [teardown]);

    // Never leave the microphone open when the composer goes away.
    useEffect(() => () => {
        cancelledRef.current = true;
        const recorder = recorderRef.current;
        recorderRef.current = null;
        if (recorder && recorder.state !== 'inactive') {
            try {
                recorder.stop();
            } catch {
                // Already gone.
            }
        }
        resolveRef.current?.(null);
        resolveRef.current = null;
        teardown();
    }, [teardown]);

    return {supported: voiceSupported(), status, durationMs, levels, start, finish, cancel};
}
