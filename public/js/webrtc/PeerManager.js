class PeerManager {
    constructor(app, rtcConfig) {
        this.app = app;
        this.rtcConfig = rtcConfig;
        this.peerConnections = {};
        this.screenPeerConnections = {};
    }

    get clientId() { return this.app.signalingClient.clientId; }
    get screenClientId() { return this.app.signalingClient.screenClientId; }

    async handleMessage(msg) {
        const peerId = msg.clientId;
        if (msg.type === 'join') {
            const isMsgScreen = peerId.toString().includes('_screen');
            if (!isMsgScreen && this.clientId.toString() < peerId.toString()) {
                await this.createPeerConnection(peerId, true, this.clientId, this.peerConnections);
            }
            if (this.app.mediaManager.screenStream) {
                await this.createPeerConnection(peerId, true, this.screenClientId, this.screenPeerConnections);
            }
        } else if (msg.type === 'leave') {
            this.removePeer(peerId);
            this.removePeer(peerId + '_screen');
        } else if (msg.type === 'offer') {
            const isSenderScreen = peerId.toString().includes('_screen');
            const targetMap = isSenderScreen ? this.screenPeerConnections : this.peerConnections;
            const pc = await this.createPeerConnection(peerId, false, msg.targetId, targetMap);
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.app.signalingClient.send({ type: 'answer', targetId: peerId, sdp: answer }, msg.targetId);
        } else if (msg.type === 'answer') {
            const isTargetScreen = msg.targetId === this.screenClientId;
            const isSenderScreen = peerId.toString().includes('_screen');
            const targetMap = (isTargetScreen || isSenderScreen) ? this.screenPeerConnections : this.peerConnections;
            const pc = targetMap[peerId];
            if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        } else if (msg.type === 'candidate') {
            const isTargetScreen = msg.targetId === this.screenClientId;
            const isSenderScreen = peerId.toString().includes('_screen');
            const targetMap = (isTargetScreen || isSenderScreen) ? this.screenPeerConnections : this.peerConnections;
            const pc = targetMap[peerId];
            if (pc && msg.candidate) {
                pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
            }
        }
    }

    async createPeerConnection(peerId, isInitiator, myId, connectionMap) {
        if (connectionMap[peerId]) return connectionMap[peerId];

        const pc = new RTCPeerConnection(this.rtcConfig);
        connectionMap[peerId] = pc;

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.app.signalingClient.send({ type: 'candidate', targetId: peerId, candidate: event.candidate }, myId);
            }
        };

        pc.ontrack = (event) => {
            this.app.uiManager.updatePeerVideo(peerId, event.streams[0]);
            // Notify transcription manager about new remote stream
            if (this.app.transcriptionManager) {
                this.app.transcriptionManager.onRemoteStreamAdded(peerId, event.streams[0]);
            }
        };

        pc.onconnectionstatechange = () => {
            const badge = document.getElementById('badge-' + peerId);
            if (badge) {
                badge.textContent = pc.connectionState;
                if (pc.connectionState === 'connected') badge.style.color = 'var(--success)';
                if (pc.connectionState === 'failed') badge.style.color = 'var(--danger)';
            }
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                setTimeout(() => {
                    if (pc.connectionState !== 'connected' && connectionMap[peerId] === pc) {
                        this.removePeerSession(peerId, connectionMap);
                    }
                }, 5000);
            }
        };

        const localStream = this.app.mediaManager.getLocalStream();
        const screenStream = this.app.mediaManager.screenStream;

        if (myId === this.clientId && localStream) {
            const isRemoteScreen = peerId.toString().includes('_screen');
            if (!isRemoteScreen) {
                localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
            }
        } else if (myId === this.screenClientId && screenStream) {
            screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));
        }

        if (isInitiator) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.app.signalingClient.send({ type: 'offer', targetId: peerId, sdp: offer }, myId);
        }

        this.app.uiManager.updatePeerVideo(peerId, null);
        return pc;
    }

    removePeerSession(peerId, map) {
        if (map[peerId]) {
            map[peerId].close();
            delete map[peerId];
        }
        const isScreenId = peerId.toString().includes('_screen');
        const baseId = isScreenId ? peerId.split('_')[0] : peerId;
        const hasAny = this.peerConnections[baseId] || this.screenPeerConnections[baseId] ||
                       this.peerConnections[baseId + '_screen'] || this.screenPeerConnections[baseId + '_screen'];

        if (!hasAny || isScreenId) {
            this.app.uiManager.removePeerVideoContainer(peerId);
        }
    }

    removePeer(peerId) {
        // Notify transcription manager about removed peer
        if (this.app.transcriptionManager) {
            this.app.transcriptionManager.onRemoteStreamRemoved(peerId);
        }
        this.removePeerSession(peerId, this.peerConnections);
        this.removePeerSession(peerId + '_screen', this.screenPeerConnections);
        this.removePeerSession(peerId, this.screenPeerConnections);
    }

    async startScreenSharing() {
        const screenStream = await this.app.mediaManager.startScreenShare();
        const screenClientId = this.screenClientId;

        this.app.uiManager.updatePeerVideo(screenClientId, screenStream);
        const badge = document.getElementById('badge-' + screenClientId);
        if (badge) badge.textContent = 'Local Screen';

        this.app.signalingClient.send({ type: 'join' }, screenClientId);

        await new Promise(r => setTimeout(r, 500));

        const invitePromises = Object.keys(this.peerConnections).map(async (id) => {
            if (id.includes('_screen')) return;
            try {
                await this.createPeerConnection(id, true, screenClientId, this.screenPeerConnections);
            } catch (err) {
                console.error('[ScreenShare] Failed to invite ' + id + ':', err);
            }
        });
        await Promise.all(invitePromises);

        screenStream.getVideoTracks()[0].onended = () => {
            this.stopScreenSharing();
        };
    }

    stopScreenSharing() {
        this.app.mediaManager.stopScreenShare();
        this.app.signalingClient.send({ type: 'leave' }, this.screenClientId);

        for (const id in this.screenPeerConnections) {
            this.removePeerSession(id, this.screenPeerConnections);
        }

        const sc = document.getElementById('container-' + this.screenClientId);
        if (sc) sc.remove();

        this.app.uiManager.toggleScreenBtn.classList.remove('active');
    }

    closeAll() {
        Object.keys(this.peerConnections).forEach(id => this.removePeer(id));
        Object.keys(this.screenPeerConnections).forEach(id => {
            this.removePeerSession(id, this.screenPeerConnections);
        });
    }
}

window.PeerManager = PeerManager;
