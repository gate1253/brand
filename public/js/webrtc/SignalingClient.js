class WebRTCSignalingClient {
    constructor(app, signalingUrl, targetCode) {
        this.app = app;
        this.signalingUrl = signalingUrl;
        this.targetCode = targetCode;
        this.ws = null;
        this.clientId = Date.now() + Math.floor(Math.random() * 1000);
        this.screenClientId = this.clientId + '_screen';
        this.processedMessageIds = new Set();
        this.lastTimestamp = 0;
        this.isAdmitted = false;
    }

    connect() {
        if (this.signalingUrl.startsWith('ws')) {
            this.connectWebSocket();
        } else {
            console.log('Using HTTP polling');
            this.send({ type: 'join' });
            this.schedulePoll(500);
        }
    }

    connectWebSocket() {
        this.ws = new WebSocket(this.signalingUrl);
        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this.app.uiManager.setStatus('Live in ' + this.targetCode, 'success');
            this.send({ type: 'join' });
        };
        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'user-count') {
                    this.app.uiManager.updateUserCount(msg.count);
                    this.handleAdmission(msg.count);
                    return;
                }
                if (msg.clientId !== this.clientId && msg.clientId !== this.screenClientId) {
                    this.app.peerManager.handleMessage(msg);
                }
            } catch (e) { console.error('WS parse error:', e); }
        };
        this.ws.onclose = () => {
            this.app.uiManager.setStatus('Reconnecting...', 'warning');
            setTimeout(() => this.connectWebSocket(), 3000);
        };
        this.ws.onerror = (e) => console.error('WS error:', e);
    }

    handleAdmission(count) {
        const localStream = this.app.mediaManager.cameraStream;
        if (!this.isAdmitted) {
            if (count <= 2) {
                this.isAdmitted = true;
                document.getElementById('waitingScreen').classList.remove('active');
                if (localStream) localStream.getTracks().forEach(t => t.enabled = true);
            } else {
                document.getElementById('waitingScreen').classList.add('active');
                if (localStream) localStream.getTracks().forEach(t => t.enabled = false);
            }
        }
    }

    send(data, fromId) {
        data.room = this.targetCode;
        data.clientId = fromId || this.clientId;
        data.msgId = Math.random().toString(36).substring(2, 11);
        data.timestamp = Date.now();

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        } else {
            fetch(this.signalingUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            }).catch(e => console.error('Signal send error:', e));
        }
    }

    schedulePoll(ms) {
        if (this.ws) return;
        setTimeout(async () => {
            await this.pollSignal();
            const interval = Object.keys(this.app.peerManager.peerConnections).length === 0 ? 1000 : 3000;
            this.schedulePoll(interval);
        }, ms);
    }

    async pollSignal() {
        try {
            const url = new URL(this.signalingUrl);
            url.searchParams.append('room', this.targetCode);
            const res = await fetch(url);
            if (res.ok && res.status !== 204) {
                const data = await res.json();
                const messages = Array.isArray(data) ? data : [data];
                messages.sort((a, b) => a.timestamp - b.timestamp);
                for (const msg of messages) {
                    if (!msg || msg.clientId === this.clientId || msg.clientId === this.screenClientId) continue;
                    const uniqueId = msg.timestamp + '-' + (msg.msgId || '0');
                    if (this.processedMessageIds.has(uniqueId)) continue;
                    this.processedMessageIds.add(uniqueId);
                    if (msg.timestamp > this.lastTimestamp) {
                        this.lastTimestamp = msg.timestamp;
                        await this.app.peerManager.handleMessage(msg);
                    }
                }
            }
        } catch (e) { console.error('Poll error:', e); }
    }

    disconnect() {
        if (this.ws) this.ws.close();
    }
}

window.WebRTCSignalingClient = WebRTCSignalingClient;
