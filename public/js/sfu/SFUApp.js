class SFUApp {
    constructor(config) {
        this.signalingUrl = config.signalingUrl;
        this.targetCode = config.targetCode;
        this.apiUrl = config.apiUrl;
        this.callsSessionId = null;

        this.mediaManager = new MediaManager(this);
        this.uiManager = new UIManager(this);
        this.signalingClient = new SignalingClient(this, this.signalingUrl, this.targetCode);
        this.webrtcManager = new WebRTCManager(this, this.apiUrl);
    }

    async start() {
        try {
            this.uiManager.setStatus('Acquiring Media...', 'warning');
            
            const localStream = await this.mediaManager.initCamera();
            this.uiManager.localVideo.srcObject = localStream;
            this.uiManager.localVideo.style.transform = 'scaleX(-1)';
            
            // Create session in Cloudflare Calls
            const sessionRes = await fetch(this.apiUrl + '/calls/session', { method: 'POST' });
            if (!sessionRes.ok) throw new Error('Failed to create Calls session');
            const sessionData = await sessionRes.json();
            this.callsSessionId = sessionData.sessionId;
            
            await this.webrtcManager.init(localStream);
            
            this.signalingClient.connect();
            await this.webrtcManager.renegotiate();
            
            this.uiManager.setStatus('Connected', 'success');
            
        } catch (err) {
            console.error("[SFUApp] Start error:", err);
            this.uiManager.setStatus('Error: ' + err.message, 'error');
        }
    }

    destroy() {
        this.signalingClient.disconnect();
        this.webrtcManager.close();
        this.mediaManager.stopAll();
    }
}

window.SFUApp = SFUApp;

// Auto-start if config is present (injected from Cloudflare Worker)
if (window.SFU_CONFIG) {
    window.onload = () => {
        const app = new SFUApp(window.SFU_CONFIG);
        app.start();
        window.sfuAppInstance = app; // Expose for debugging
    };
}
