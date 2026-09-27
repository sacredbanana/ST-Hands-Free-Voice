// Convert decoded microphone audio to mono, 16-bit PCM WAV.
export function encodeWav(audioBuffer) {
    const sampleCount = audioBuffer.length;
    const channelCount = audioBuffer.numberOfChannels;
    if (!sampleCount || !channelCount) {
        throw new Error('The microphone recording contains no audio.');
    }

    const samples = Array.from({ length: channelCount }, (_, channel) => audioBuffer.getChannelData(channel));
    const bytesPerSample = 2;
    const dataSize = sampleCount * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeString = (offset, value) => {
        for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, audioBuffer.sampleRate, true);
    view.setUint32(28, audioBuffer.sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    for (let i = 0; i < sampleCount; i++) {
        let sample = 0;
        for (const channel of samples) sample += channel[i];
        sample = Math.max(-1, Math.min(1, sample / channelCount));
        view.setInt16(44 + i * bytesPerSample, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
}
