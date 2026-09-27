import { defaultSettings, VOLUME_THRESHOLD } from './constants.js';
import { runtimeState } from './state.js';
import { getSettings } from './settings.js';
import { getContext } from './sillytavern.js';
import { transcribeAndSend } from './transcription.js';
import { renderHandsFreeControls } from './ui.js';
import { reportMicrophonePermissionError, reportSetupError, validateSetupBeforeListening } from './validation.js';
import { encodeWav } from './wav.js';

function getVolumeThreshold() {
    return Number(getSettings().volume_threshold) || VOLUME_THRESHOLD;
}

export function getCurrentVolume() {
    if (!runtimeState.analyserNode) return 0;
    const data = new Uint8Array(runtimeState.analyserNode.frequencyBinCount);
    runtimeState.analyserNode.getByteFrequencyData(data);
    return data.reduce((a, b) => a + b, 0) / data.length;
}

export async function startVoiceDetection() {
    if (runtimeState.isListening) return;
    if (!validateSetupBeforeListening()) {
        const settings = getSettings();
        settings.enabled = false;
        getContext().saveSettingsDebounced();
        renderHandsFreeControls();
        await stopListening();
        return;
    }

    try {
        runtimeState.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        runtimeState.audioContext = new (window.AudioContext || window.webkitAudioContext)();

        if (runtimeState.audioContext.state === 'suspended') {
            try {
                await runtimeState.audioContext.resume();
            } catch (err) {
                console.warn("⚠️ AudioContext resume failed:", err);
            }
        }

        runtimeState.sourceNode = runtimeState.audioContext.createMediaStreamSource(runtimeState.mediaStream);
        runtimeState.analyserNode = runtimeState.audioContext.createAnalyser();
        runtimeState.analyserNode.fftSize = 512;
        runtimeState.sourceNode.connect(runtimeState.analyserNode);

        runtimeState.isListening = true;
        renderHandsFreeControls();
        let speechDetected = false;

        const checkLevel = () => {
            runtimeState.voiceDetectionFrame = null;
            if (!runtimeState.isListening || speechDetected) return;
            const volume = getCurrentVolume();
            const threshold = getVolumeThreshold();
            if (volume > threshold) {
                speechDetected = true;
                console.log("🗣️ Speech detected – recording");
                if (runtimeState.silenceTimer) {
                    clearTimeout(runtimeState.silenceTimer);
                    runtimeState.silenceTimer = null;
                }
                startRecording();
                renderHandsFreeControls();
                return;
            }
            runtimeState.voiceDetectionFrame = requestAnimationFrame(checkLevel);
        };
        runtimeState.voiceDetectionFrame = requestAnimationFrame(checkLevel);
    } catch (err) {
        console.error("❌ Mic access failed:", err);
        if (isMicrophonePermissionError(err)) {
            reportMicrophonePermissionError();
        }
        await stopListening();
    }
}

function isMicrophonePermissionError(err) {
    return err?.name === 'NotAllowedError'
        || err?.name === 'PermissionDeniedError'
        || err?.name === 'SecurityError';
}

export async function startRecording() {
    if (!runtimeState.mediaStream) return;
    runtimeState.recorder = new MediaRecorder(runtimeState.mediaStream);
    const chunks = [];

    runtimeState.recorder.ondataavailable = e => chunks.push(e.data);
    runtimeState.recorder.onstop = async () => {
        runtimeState.isListening = false;
        runtimeState.recorder = null;
        clearVolumePoller();
        let wavBlob;
        try {
            const recordedBlob = new Blob(chunks);
            const decoded = await runtimeState.audioContext.decodeAudioData(await recordedBlob.arrayBuffer());
            wavBlob = encodeWav(decoded);
        } catch (err) {
            console.error('❌ Could not convert microphone recording to WAV:', err);
            reportSetupError('Could not convert the microphone recording to WAV. Check the browser console for details.');
        } finally {
            await releaseAudioResources();
        }
        if (wavBlob) await transcribeAndSend(wavBlob, stopListening);
    };

    runtimeState.recorder.start();
    renderHandsFreeControls();

    const settings = getSettings();
    const speechPauseMs = (settings.speech_pause || defaultSettings.speech_pause) * 1000;
    const maxRecordingMs = (settings.max_recording || defaultSettings.max_recording) * 1000;
    const pollIntervalMs = 100;

    let silentFor = 0;
    const startTime = Date.now();

    // Poll for in-speech silence and max-length cutoff
    clearVolumePoller();
    runtimeState.volumePoller = setInterval(() => {
        if (!runtimeState.recorder || runtimeState.recorder.state !== "recording") {
            clearVolumePoller();
            return;
        }

        // Safety cap: max recording length
        if (Date.now() - startTime >= maxRecordingMs) {
            console.log(`⏱️ Max recording length (${getSettings().max_recording}s) reached – stopping`);
            clearVolumePoller();
            runtimeState.recorder.stop();
            return;
        }

        // Check for post-speech silence
        const volume = getCurrentVolume();
        if (volume <= getVolumeThreshold()) {
            silentFor += pollIntervalMs;
            if (silentFor >= speechPauseMs) {
                console.log(`🤫 Speech pause (${getSettings().speech_pause}s) reached – stopping recording`);
                clearVolumePoller();
                runtimeState.recorder.stop();
            }
        } else {
            silentFor = 0; // reset on any sound
        }
    }, pollIntervalMs);
}

function clearSilenceTimer() {
    if (!runtimeState.silenceTimer) return;
    clearTimeout(runtimeState.silenceTimer);
    runtimeState.silenceTimer = null;
}

function clearVolumePoller() {
    if (!runtimeState.volumePoller) return;
    clearInterval(runtimeState.volumePoller);
    runtimeState.volumePoller = null;
}

function cancelVoiceDetectionFrame() {
    if (!runtimeState.voiceDetectionFrame) return;
    cancelAnimationFrame(runtimeState.voiceDetectionFrame);
    runtimeState.voiceDetectionFrame = null;
}

async function releaseAudioResources() {
    if (runtimeState.sourceNode) {
        try {
            runtimeState.sourceNode.disconnect();
        } catch (err) {
            // The node may already be disconnected during browser teardown.
        }
    }

    if (runtimeState.mediaStream) {
        runtimeState.mediaStream.getTracks().forEach(track => track.stop());
    }

    if (runtimeState.audioContext) {
        try {
            if (runtimeState.audioContext.state !== 'closed') {
                await runtimeState.audioContext.close();
            }
        } catch (err) {
            console.warn("⚠️ AudioContext close failed:", err);
        }
    }

    runtimeState.mediaStream = null;
    runtimeState.sourceNode = null;
    runtimeState.audioContext = null;
    runtimeState.analyserNode = null;
    renderHandsFreeControls();
}

export async function stopListening() {
    if (runtimeState.isStopping) return;
    runtimeState.isStopping = true;

    try {
        runtimeState.isListening = false;
        clearSilenceTimer();
        clearVolumePoller();
        cancelVoiceDetectionFrame();

        if (runtimeState.recorder && runtimeState.recorder.state === "recording") {
            runtimeState.recorder.onstop = null;
            try {
                runtimeState.recorder.stop();
            } catch (err) {
                console.warn("⚠️ Recorder stop failed:", err);
            }
        }

        await releaseAudioResources();
    } finally {
        runtimeState.isStopping = false;
    }

    runtimeState.recorder = null;
    renderHandsFreeControls();
}
