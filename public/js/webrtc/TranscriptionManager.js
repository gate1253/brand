/**
 * TranscriptionManager
 * - Collects audio tracks from REMOTE peers only (excludes local/self)
 * - Buffers audio for 30 seconds and sends as WAV via WebSocket
 * - Provides language selection UI (auto, ko, en, ja)
 * - Displays real-time subtitles overlay
 */
class TranscriptionManager {
    constructor(app) {
        this.app = app;
        this.isActive = false;
        this.selectedLang = 'auto'; // 'auto', 'ko', 'en', 'ja'
        this.transcriptWs = null;
        this.audioContext = null;
        this.mixedDestination = null;
        this.remoteSourceNodes = {}; // peerId -> MediaStreamAudioSourceNode
        this.workletNode = null;
        this.audioInputBuffer = [];
        this.subTimeout = null;
        this.BUFFER_SECONDS = 5;
        this.OVERLAP_SECONDS = 1; // Send 5s every 4s (1s overlap)
        this.TARGET_SAMPLE_RATE = 16000;

        this.subtitleOverlay = document.getElementById('subtitleOverlay');
        this.subtitleText = this.subtitleOverlay.querySelector('span');
        this.toggleCCBtn = document.getElementById('toggleCC');
        this.langSelect = document.getElementById('langSelect');
        this.langMenu = document.getElementById('langMenu');

        this.processorCode = `
            class RecorderProcessor extends AudioWorkletProcessor {
                constructor() {
                    super();
                    this.bufferSize = 4096;
                    this.buffer = new Float32Array(this.bufferSize);
                    this.bytesWritten = 0;
                }
                process(inputs, outputs, parameters) {
                    const input = inputs[0];
                    if (input && input.length > 0) {
                        const channelData = input[0];
                        for (let i = 0; i < channelData.length; i++) {
                            this.buffer[this.bytesWritten++] = channelData[i];
                            if (this.bytesWritten >= this.bufferSize) {
                                this.port.postMessage(this.buffer.slice());
                                this.bytesWritten = 0;
                            }
                        }
                    }
                    return true;
                }
            }
            registerProcessor('recorder-processor', RecorderProcessor);
        `;

        this.bindEvents();
    }

    bindEvents() {
        this.toggleCCBtn.onclick = () => {
            this.isActive = !this.isActive;
            this.toggleCCBtn.classList.toggle('active', this.isActive);
            this.subtitleOverlay.style.display = this.isActive ? 'block' : 'none';

            if (this.isActive) {
                this.start();
            } else {
                this.stop();
            }
        };

        // Language menu toggle
        if (this.langSelect) {
            this.langSelect.onclick = (e) => {
                e.stopPropagation();
                this.langMenu.classList.toggle('show');
            };
        }

        // Language option click
        document.querySelectorAll('.lang-option').forEach(opt => {
            opt.onclick = (e) => {
                e.stopPropagation();
                document.querySelectorAll('.lang-option').forEach(el => el.classList.remove('active'));
                opt.classList.add('active');
                this.selectedLang = opt.dataset.lang;
                if (this.langSelect) {
                    this.langSelect.textContent = opt.textContent;
                }
                this.langMenu.classList.remove('show');

                // If already connected, notify server of language change
                if (this.transcriptWs && this.transcriptWs.readyState === WebSocket.OPEN) {
                    this.transcriptWs.send(JSON.stringify({ type: 'set-language', lang: this.selectedLang }));
                }
            };
        });

        window.addEventListener('click', () => {
            if (this.langMenu) this.langMenu.classList.remove('show');
        });
    }

    /**
     * Called by PeerManager when a new remote stream arrives.
     * Adds the remote audio track to our mixed audio context.
     */
    onRemoteStreamAdded(peerId, stream) {
        if (!this.isActive || !this.audioContext || !this.mixedDestination) return;
        if (!stream || peerId.toString().includes('_screen')) return;

        // Check if stream has audio tracks
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) return;

        // Remove existing source for this peer if any
        this.removeRemoteSource(peerId);

        try {
            const source = this.audioContext.createMediaStreamSource(stream);
            source.connect(this.mixedDestination);
            this.remoteSourceNodes[peerId] = source;
            console.log('[Transcription] Added remote audio from peer:', peerId);
        } catch (e) {
            console.error('[Transcription] Failed to add remote audio:', e);
        }
    }

    /**
     * Called by PeerManager when a remote peer leaves.
     */
    onRemoteStreamRemoved(peerId) {
        this.removeRemoteSource(peerId);
    }

    removeRemoteSource(peerId) {
        if (this.remoteSourceNodes[peerId]) {
            try {
                this.remoteSourceNodes[peerId].disconnect();
            } catch (e) { /* already disconnected */ }
            delete this.remoteSourceNodes[peerId];
            console.log('[Transcription] Removed remote audio from peer:', peerId);
        }
    }

    async start() {
        // Connect to transcription Worker
        this.transcriptWs = new WebSocket('wss://realtime-transcription.gate1253.workers.dev');
        this.transcriptWs.binaryType = 'arraybuffer';

        this.transcriptWs.onopen = () => {
            console.log('[Transcription] Connected to Server');
            this.subtitleText.textContent = 'Listening...';
            // Send initial language setting
            this.transcriptWs.send(JSON.stringify({ type: 'set-language', lang: this.selectedLang }));
        };

        this.transcriptWs.onerror = (e) => {
            console.error('[Transcription] Connection Error', e);
            this.subtitleText.textContent = 'Server Error';
        };

        this.transcriptWs.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.text) {
                    this.showSubtitle(data.text);
                }
            } catch (err) { /* ignore non-JSON */ }
        };

        // Setup AudioContext for mixing remote streams
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AudioCtx({ sampleRate: this.TARGET_SAMPLE_RATE });
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        this.mixedDestination = this.audioContext.createMediaStreamDestination();

        // Add all currently connected remote peer streams
        const peerConnections = this.app.peerManager.peerConnections;
        for (const peerId in peerConnections) {
            if (peerId.toString().includes('_screen')) continue;
            const pc = peerConnections[peerId];
            const receivers = pc.getReceivers();
            for (const receiver of receivers) {
                if (receiver.track && receiver.track.kind === 'audio') {
                    try {
                        const remoteStream = new MediaStream([receiver.track]);
                        const source = this.audioContext.createMediaStreamSource(remoteStream);
                        source.connect(this.mixedDestination);
                        this.remoteSourceNodes[peerId] = source;
                        console.log('[Transcription] Connected existing remote audio from peer:', peerId);
                    } catch (e) {
                        console.error('[Transcription] Error connecting existing peer audio:', e);
                    }
                }
            }
        }

        // Load AudioWorklet for buffering
        const blob = new Blob([this.processorCode], { type: 'application/javascript' });
        await this.audioContext.audioWorklet.addModule(URL.createObjectURL(blob));

        this.workletNode = new AudioWorkletNode(this.audioContext, 'recorder-processor');

        // Connect mixed destination stream to worklet
        const mixedSource = this.audioContext.createMediaStreamSource(this.mixedDestination.stream);
        mixedSource.connect(this.workletNode);
        this.workletNode.connect(this.audioContext.destination);

        this.audioInputBuffer = [];

        this.workletNode.port.onmessage = (e) => {
            if (!this.isActive || !this.transcriptWs || this.transcriptWs.readyState !== WebSocket.OPEN) return;

            const inputData = e.data;
            for (let i = 0; i < inputData.length; i++) {
                this.audioInputBuffer.push(inputData[i]);
            }

            // Buffer for BUFFER_SECONDS worth of samples
            const requiredSamples = this.TARGET_SAMPLE_RATE * this.BUFFER_SECONDS;

            if (this.audioInputBuffer.length >= requiredSamples) {
                const rawData = new Float32Array(this.audioInputBuffer);
                
                // Keep the overlap for the next buffer
                const overlapSamples = this.TARGET_SAMPLE_RATE * this.OVERLAP_SECONDS;
                this.audioInputBuffer = this.audioInputBuffer.slice(this.audioInputBuffer.length - overlapSamples);

                // Reduced threshold to 0.002 to ensure sound is detected even if quiet
                if (rms < 0.002) {
                    console.log('[Transcription] silence (RMS:', rms.toFixed(5), ')');
                    return;
                }

                this.subtitleText.textContent = 'Processing...';
                console.log('[Transcription] Sending', this.BUFFER_SECONDS, 's buffer with', this.OVERLAP_SECONDS, 's overlap (RMS:', rms.toFixed(5), ')');
                const wavBuffer = this.encodeWAV(rawData, this.TARGET_SAMPLE_RATE);
                this.transcriptWs.send(wavBuffer);
            }
        };
    }

    stop() {
        if (this.transcriptWs) {
            this.transcriptWs.close();
            this.transcriptWs = null;
        }
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }
        // Disconnect all remote source nodes
        for (const peerId in this.remoteSourceNodes) {
            this.removeRemoteSource(peerId);
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.mixedDestination = null;
        this.audioInputBuffer = [];
        this.subtitleText.textContent = '';
    }

    showSubtitle(text) {
        this.subtitleText.textContent = text;
        this.subtitleOverlay.style.opacity = '1';

        clearTimeout(this.subTimeout);
        this.subTimeout = setTimeout(() => {
            this.subtitleOverlay.style.opacity = '0';
        }, 5000);
    }

    encodeWAV(samples, sampleRate) {
        const buffer = new ArrayBuffer(44 + samples.length * 2);
        const view = new DataView(buffer);

        this.writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + samples.length * 2, true);
        this.writeString(view, 8, 'WAVE');
        this.writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        this.writeString(view, 36, 'data');
        view.setUint32(40, samples.length * 2, true);

        this.floatTo16BitPCM(view, 44, samples);
        return buffer;
    }

    writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    floatTo16BitPCM(output, offset, input) {
        for (let i = 0; i < input.length; i++, offset += 2) {
            let s = Math.max(-1, Math.min(1, input[i]));
            output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
    }
}

window.TranscriptionManager = TranscriptionManager;
