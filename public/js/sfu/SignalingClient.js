class SignalingClient {
    constructor(app, url, targetCode) {
        this.app = app;
        this.url = url;
        this.targetCode = targetCode;
        this.ws = null;
    }

    connect() {
        console.info('[SignalingClient] Connecting WebSocket...');
        this.ws = new WebSocket(this.url);
        
        this.ws.onopen = () => {
            console.info('[SignalingClient] WebSocket Connected');
            this.send({ 
                type: 'join', 
                room: this.targetCode, 
                sessionId: this.app.callsSessionId,
                clientId: this.app.callsSessionId 
            });
            this.app.webrtcManager.broadcastLocalTracks();
        };

        this.ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            console.info('[SignalingClient] WS Message:', msg.type, msg.sessionId || msg.clientId);
            
            if (msg.type === 'user-count') {
                this.app.uiManager.updateUserCount(msg.count);
            } else if (this.isFromOtherUser(msg)) {
                if (msg.type === 'tracks-update') {
                    this.app.webrtcManager.handleRemoteTracksUpdate(msg);
                } else if (msg.type === 'leave') {
                    this.app.webrtcManager.handleRemoteLeave(msg);
                } else if (msg.type === 'join') {
                    this.app.webrtcManager.broadcastLocalTracks();
                }
            }
        };

        this.ws.onerror = (e) => console.error('[SignalingClient] WS Error:', e);
        this.ws.onclose = () => console.info('[SignalingClient] WS Closed');
    }

    isFromOtherUser(msg) {
        return msg.sessionId !== this.app.callsSessionId && msg.clientId !== this.app.callsSessionId;
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    disconnect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.send({ 
                type: 'leave', 
                room: this.targetCode, 
                sessionId: this.app.callsSessionId,
                clientId: this.app.callsSessionId
            });
            this.ws.close();
        }
    }

    isOpen() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }
}

window.SignalingClient = SignalingClient;
