class SignalingClient {
    constructor(app, url, targetCode) {
        this.app = app;
        this.url = url;
        this.targetCode = targetCode;
        this.ws = null;

        // Reconnection state
        this._reconnectAttempt = 0;
        this._reconnectTimer = null;
        this._intentionalClose = false;
        this._maxReconnectAttempts = 12;
        this._baseDelay = 500;    // ms
        this._maxDelay = 30000;   // ms
    }

    connect() {
        this._intentionalClose = false;
        this._clearReconnectTimer();

        console.info('[SignalingClient] Connecting WebSocket...');
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
            console.info('[SignalingClient] WebSocket Connected');
            this._reconnectAttempt = 0;

            this.send({
                type: 'join',
                room: this.targetCode,
                sessionId: this.app.callsSessionId,
                clientId: this.app.callsSessionId
            });
            this.app.webrtcManager.broadcastLocalTracks();
        };

        this.ws.onmessage = (e) => {
            let msg;
            try {
                msg = JSON.parse(e.data);
            } catch (err) {
                console.error('[SignalingClient] Invalid JSON:', e.data);
                return;
            }

            console.info('[SignalingClient] WS Message:', msg.type, msg.sessionId || msg.clientId);

            // User count updates from server
            if (msg.type === 'user-count') {
                this.app.uiManager.updateUserCount(msg.count);
                return;
            }

            // Ignore own messages
            if (!this.isFromOtherUser(msg)) return;

            switch (msg.type) {
                // --- Signal actions: Offer / Answer / Candidate ---
                case 'signal':
                    this._handleSignal(msg);
                    break;
                case 'offer':
                    this._handleOffer(msg);
                    break;
                case 'answer':
                    this._handleAnswer(msg);
                    break;
                case 'candidate':
                    this._handleCandidate(msg);
                    break;

                // --- SFU track negotiation ---
                case 'tracks-update':
                    this.app.webrtcManager.handleRemoteTracksUpdate(msg);
                    break;

                // --- VAD speaker highlight ---
                case 'speaker-update':
                    this.app.uiManager.handleSpeakerUpdate(msg.sessionId || msg.clientId, msg.speaker);
                    break;

                // --- Presence ---
                case 'leave':
                    this.app.webrtcManager.handleRemoteLeave(msg);
                    break;
                case 'join':
                case 'user_joined':
                    this.app.webrtcManager.broadcastLocalTracks();
                    break;

                default:
                    console.warn('[SignalingClient] Unknown message type:', msg.type);
            }
        };

        this.ws.onerror = (e) => {
            console.error('[SignalingClient] WS Error:', e);
        };

        this.ws.onclose = (e) => {
            console.info('[SignalingClient] WS Closed (code=' + e.code + ', reason=' + e.reason + ')');

            if (!this._intentionalClose) {
                this._scheduleReconnect();
            }
        };
    }

    // ── Signal action handlers ──────────────────────────────────

    /**
     * Multiplexed signal message: { type: 'signal', action: 'offer'|'answer'|'candidate', payload: ... }
     */
    _handleSignal(msg) {
        const action = msg.action;
        if (!action) {
            console.warn('[SignalingClient] signal message missing action field');
            return;
        }

        switch (action) {
            case 'offer':
                this._handleOffer(msg);
                break;
            case 'answer':
                this._handleAnswer(msg);
                break;
            case 'candidate':
                this._handleCandidate(msg);
                break;
            default:
                console.warn('[SignalingClient] Unknown signal action:', action);
        }
    }

    async _handleOffer(msg) {
        const pc = this.app.webrtcManager.pc;
        if (!pc) return;

        const sdp = msg.payload?.sdp || msg.sdp;
        if (!sdp) {
            console.warn('[SignalingClient] Offer missing SDP');
            return;
        }

        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            this.send({
                type: 'signal',
                action: 'answer',
                payload: { sdp: pc.localDescription.sdp },
                sessionId: this.app.callsSessionId,
                clientId: this.app.callsSessionId,
                room: this.targetCode,
                targetClientId: msg.clientId || msg.sessionId
            });
        } catch (err) {
            console.error('[SignalingClient] Error handling offer:', err);
        }
    }

    async _handleAnswer(msg) {
        const pc = this.app.webrtcManager.pc;
        if (!pc) return;

        const sdp = msg.payload?.sdp || msg.sdp;
        if (!sdp) {
            console.warn('[SignalingClient] Answer missing SDP');
            return;
        }

        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
        } catch (err) {
            console.error('[SignalingClient] Error handling answer:', err);
        }
    }

    async _handleCandidate(msg) {
        const pc = this.app.webrtcManager.pc;
        if (!pc) return;

        const candidate = msg.payload?.candidate || msg.candidate;
        if (!candidate) return;

        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.error('[SignalingClient] Error adding ICE candidate:', err);
        }
    }

    // ── Convenience senders ─────────────────────────────────────

    sendOffer(sdp, targetClientId) {
        this.send({
            type: 'signal',
            action: 'offer',
            payload: { sdp },
            sessionId: this.app.callsSessionId,
            clientId: this.app.callsSessionId,
            room: this.targetCode,
            targetClientId
        });
    }

    sendAnswer(sdp, targetClientId) {
        this.send({
            type: 'signal',
            action: 'answer',
            payload: { sdp },
            sessionId: this.app.callsSessionId,
            clientId: this.app.callsSessionId,
            room: this.targetCode,
            targetClientId
        });
    }

    sendCandidate(candidate, targetClientId) {
        this.send({
            type: 'signal',
            action: 'candidate',
            payload: { candidate },
            sessionId: this.app.callsSessionId,
            clientId: this.app.callsSessionId,
            room: this.targetCode,
            targetClientId
        });
    }

    // ── Reconnection with exponential backoff ───────────────────

    _scheduleReconnect() {
        if (this._reconnectAttempt >= this._maxReconnectAttempts) {
            console.error('[SignalingClient] Max reconnect attempts (' + this._maxReconnectAttempts + ') reached. Giving up.');
            this.app.uiManager.setStatus('Disconnected — please refresh', 'error');
            return;
        }

        // Exponential backoff: delay = min(base * 2^attempt + jitter, maxDelay)
        const exponential = this._baseDelay * Math.pow(2, this._reconnectAttempt);
        const jitter = Math.random() * this._baseDelay;
        const delay = Math.min(exponential + jitter, this._maxDelay);

        this._reconnectAttempt++;
        console.info('[SignalingClient] Reconnecting in ' + Math.round(delay) + 'ms (attempt ' + this._reconnectAttempt + '/' + this._maxReconnectAttempts + ')');
        this.app.uiManager.setStatus('Reconnecting...', 'warning');

        this._reconnectTimer = setTimeout(() => this.connect(), delay);
    }

    _clearReconnectTimer() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    // ── Core helpers ────────────────────────────────────────────

    isFromOtherUser(msg) {
        return msg.sessionId !== this.app.callsSessionId && msg.clientId !== this.app.callsSessionId;
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    disconnect() {
        this._intentionalClose = true;
        this._clearReconnectTimer();

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
