class WebRTCApp {
    constructor(config) {
        this.signalingUrl = config.signalingUrl;
        this.targetCode = config.targetCode;
        this.iceServers = config.iceServers || [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ];

        const rtcConfig = {
            iceServers: this.iceServers,
            iceCandidatePoolSize: 10
        };

        this.mediaManager = new WebRTCMediaManager(this);
        this.uiManager = new WebRTCUIManager(this);
        this.signalingClient = new WebRTCSignalingClient(this, this.signalingUrl, this.targetCode);
        this.peerManager = new PeerManager(this, rtcConfig);
        this.transcriptionManager = new TranscriptionManager(this);
    }

    async start() {
        try {
            this.uiManager.setStatus('Requesting media access...', 'warning');

            const cameraStream = await this.mediaManager.initCamera();

            if (cameraStream) {
                this.uiManager.localVideo.srcObject = cameraStream;
                this.uiManager.localVideo.style.transform = 'scaleX(-1)';
                if (!cameraStream.getVideoTracks().length) {
                    document.getElementById('localVideoContainer').classList.add('no-video');
                    this.uiManager.isVideoOn = false;
                    this.uiManager.toggleVideoBtn.classList.add('off');
                }
            } else {
                document.getElementById('localVideoContainer').classList.add('no-video');
                this.uiManager.isVideoOn = false;
                this.uiManager.isMicOn = false;
                this.uiManager.toggleMicBtn.classList.add('off');
                this.uiManager.toggleVideoBtn.classList.add('off');
            }

            this.uiManager.setStatus('Connecting to signaling...', 'warning');
            this.signalingClient.connect();

        } catch (err) {
            console.error('[WebRTCApp] Start error:', err);
            this.uiManager.setStatus('Error: ' + err.message, 'error');
        }
    }

    destroy() {
        this.transcriptionManager.stop();
        this.signalingClient.disconnect();
        this.peerManager.closeAll();
        this.mediaManager.stopAll();
    }
}

window.WebRTCApp = WebRTCApp;

// Auto-start
window.onload = () => {
    if (window.WEBRTC_CONFIG) {
        const app = new WebRTCApp(window.WEBRTC_CONFIG);
        window.webrtcAppInstance = app;

        // Handle lobby
        const lobbyScreen = document.getElementById('lobbyScreen');
        const enterBtn = document.getElementById('enterBtn');
        if (lobbyScreen && enterBtn) {
            lobbyScreen.classList.add('active');
            enterBtn.onclick = () => {
                lobbyScreen.classList.remove('active');
                app.start();
            };
        } else {
            app.start();
        }
    }
};
