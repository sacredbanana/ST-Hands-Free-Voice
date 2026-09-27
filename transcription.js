import { PROVIDERS } from './constants.js';
import { runtimeState } from './state.js';
import { getEffectiveEndpoint, getSettings } from './settings.js';
import { getContext, sendMessageAsUser } from './sillytavern.js';
import { renderHandsFreeControls } from './ui.js';
import { reportSetupError } from './validation.js';

export async function transcribeAndSend(audioBlob, stopListening) {
    const settings = getSettings();
    const provider = PROVIDERS[settings.provider];

    if (settings.provider !== 'local' && !settings.api_key?.trim()) {
        reportSetupError('API key missing for the selected speech-to-text provider. Add it in the extension settings.');
        stopListening();
        return;
    }

    const endpoint = getEffectiveEndpoint();
    if (!endpoint) {
        reportSetupError('Local/custom speech-to-text endpoint is missing or invalid. Check the endpoint URL in the extension settings.');
        stopListening();
        return;
    }

    const providerFormat = provider?.format ?? 'multipart';

    console.log(`🎙️ Transcribing via ${settings.provider} (${providerFormat}), blob: ${audioBlob.size} bytes`);

    let res;
    try {
        runtimeState.isTranscribing = true;
        renderHandsFreeControls();

        if (providerFormat === 'json_base64') {
            // ── OpenRouter: JSON body with base64-encoded audio ──────────────
            const arrayBuffer = await audioBlob.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            const chunkSize = 8192;
            for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
            }
            const base64 = btoa(binary);

            res = await fetch(`${endpoint}/audio/transcriptions`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${settings.api_key}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    input_audio: { data: base64, format: 'wav' },
                    model: settings.model
                })
            });
        } else {
            // ── Groq / Local / OpenAI-compatible: multipart FormData ─────────
            const formData = new FormData();
            formData.append("file", audioBlob, "recording.wav");
            formData.append("model", settings.model);
            const headers = settings.api_key?.trim()
                ? { "Authorization": `Bearer ${settings.api_key.trim()}` }
                : {};

            res = await fetch(`${endpoint}/audio/transcriptions`, {
                method: "POST",
                headers,
                body: formData
            });
        }

        if (!res.ok) {
            const errorBody = await res.text();
            console.error(`❌ Whisper API error ${res.status}:`, errorBody);
            stopListening();
            return;
        }

        const data = await res.json();
        let transcribed = (data.text || data.transcript || '').trim();

        if (transcribed) {
            if (settings.quote_speech) {
                transcribed = `"${transcribed}"`;
            }
            console.log("📝 Whisper transcribed:", transcribed);
            await sendMessageAsUser(transcribed);
            // Trigger character response
            await getContext().generate('normal');
        } else {
            console.log("🔇 No speech recognized in audio");
        }
    } catch (err) {
        console.error("❌ Whisper API error:", err);
    } finally {
        runtimeState.isTranscribing = false;
        renderHandsFreeControls();
    }

    stopListening();
}
