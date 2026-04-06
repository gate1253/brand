class WebRTCManager {
    constructor(app, apiUrl) {
        this.app = app;
        this.apiUrl = apiUrl;
        this.pc = null;
        this.transceiversMap = new Map();
        this.subscribedTracks = new Set();
        this.remoteStreams = new Map(); // sessionId -> MediaStream
        this.pendingRemoteTracks = [];
        this.isRenegotiating = false;
        this.negotiationQueue = false;
    }

    getTrackName(track) {
        if (!track) return 'video';
        if (track.kind === 'audio') return 'audio';
        if (this.app.mediaManager.screenStream && this.app.mediaManager.screenStream.getVideoTracks().includes(track)) return 'screen';
        return 'video';
    }

    async init(localStream) {
        this.pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
            bundlePolicy: 'max-bundle'
        });

        this.pc.ontrack = (event) => {
            const mid = event.transceiver.mid;
            const info = this.transceiversMap.get(mid);
            console.info('[WebRTCManager] pc.ontrack:', mid, info, event.track.kind);
            if (info && info.location === 'remote') {
                this.app.uiManager.setupRemoteVideo(info, event.track, this.remoteStreams);
            }
        };

        if (localStream) {
            localStream.getTracks().forEach(track => {
                if (track.kind === 'video') {
                    this.pc.addTransceiver(track, {
                        direction: 'sendonly',
                        sendEncodings: [
                            { rid: 'h', maxBitrate: 1_200_000, scaleResolutionDownBy: 1 },
                            { rid: 'm', maxBitrate: 300_000, scaleResolutionDownBy: 2 },
                            { rid: 'l', maxBitrate: 100_000, scaleResolutionDownBy: 4 }
                        ]
                    });
                } else {
                    this.pc.addTransceiver(track, { direction: 'sendonly' });
                }
            });
        }
    }

    async renegotiate() {
        const callsSessionId = this.app.callsSessionId;
        if (!this.pc || !callsSessionId) return;
        if (this.isRenegotiating) {
            this._renegotiateQueued = true;
            return;
        }
        
        this.isRenegotiating = true;
        try {
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);
            
            const sessionDescription = this.pc.localDescription;
            const tracks = [];
            const localTracksInfo = [];
            
            this.pc.getTransceivers().forEach(t => {
                 if (t.direction === 'sendonly' || t.direction === 'sendrecv') {
                     const trackName = this.getTrackName(t.sender.track);
                     const trackEntry = { location: 'local', mid: t.mid, trackName };
                     if (t.sender.track && t.sender.track.kind === 'video' && trackName !== 'screen') {
                         const params = t.sender.getParameters();
                         if (params.encodings && params.encodings.length > 1) {
                             trackEntry.simulcastEncodings = params.encodings.map(enc => ({
                                 rid: enc.rid,
                                 maxBitrate: enc.maxBitrate,
                                 scaleResolutionDownBy: enc.scaleResolutionDownBy
                             }));
                         }
                     }
                     tracks.push(trackEntry);
                     localTracksInfo.push({ trackName, mid: t.mid, simulcast: !!trackEntry.simulcastEncodings });
                     this.transceiversMap.set(t.mid, { location: 'local', trackName, sessionId: callsSessionId });
                 } else if (t.direction === 'recvonly') {
                     const mapped = this.transceiversMap.get(t.mid);
                     if (mapped && mapped.location === 'remote') {
                         tracks.push({ location: 'remote', sessionId: mapped.sessionId, trackName: mapped.trackName });
                     }
                 }
            });
            
            const res = await fetch(this.apiUrl + `/calls/sessions/${callsSessionId}/tracks/new`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionDescription, tracks })
            });
            
            const data = await res.json();
            if (!res.ok) throw new Error(data.errorDescription || 'Renegotiation failed');
    
            if (data.tracks) {
                data.tracks.forEach(t => {
                    if (t.mid) {
                        this.transceiversMap.set(t.mid, { 
                            location: t.location || 'remote', 
                            sessionId: t.sessionId, 
                            trackName: t.trackName 
                        });
                    }
                });
            }

            const remoteSdp = data.sdp || (data.sessionDescription ? data.sessionDescription.sdp : null);
            const remoteType = data.type || (data.sessionDescription ? data.sessionDescription.type : 'answer');
            await this.pc.setRemoteDescription(new RTCSessionDescription({ type: remoteType, sdp: remoteSdp }));

            if (this.app.signalingClient && this.app.signalingClient.isOpen()) {
                console.info('[WebRTCManager] Sending tracks-update after renegotiate');
                this.app.signalingClient.send({ 
                    type: 'tracks-update', 
                    sessionId: callsSessionId, 
                    clientId: callsSessionId, 
                    tracks: localTracksInfo, 
                    room: this.app.targetCode 
                });
            }
        } catch (e) {
            console.error("[WebRTCManager] Renegotiate Error:", e);
        } finally {
            this.isRenegotiating = false;
            if (this._renegotiateQueued) {
                this._renegotiateQueued = false;
                setTimeout(() => this.renegotiate(), 50);
            } else if (this.pendingRemoteTracks.length > 0) {
                setTimeout(() => this.processPendingTracks(), 100);
            }
        }
    }

    broadcastLocalTracks() {
        const callsSessionId = this.app.callsSessionId;
        if (!this.pc || !this.app.signalingClient || !this.app.signalingClient.isOpen()) return;
        
        console.info('[WebRTCManager] Broadcasting local tracks');
        const localTracksInfo = [];
        this.pc.getTransceivers().forEach(t => {
            if ((t.direction === 'sendonly' || t.direction === 'sendrecv') && t.sender.track) {
                const trackName = this.getTrackName(t.sender.track);
                localTracksInfo.push({ trackName, mid: t.mid });
            }
        });
        
        this.app.signalingClient.send({ 
            type: 'tracks-update', 
            sessionId: callsSessionId, 
            clientId: callsSessionId, 
            tracks: localTracksInfo, 
            room: this.app.targetCode 
        });
    }

    async processPendingTracks() {
        const callsSessionId = this.app.callsSessionId;
        if (!this.pc || !callsSessionId || this.isRenegotiating || this.pendingRemoteTracks.length === 0) return;
        
        this.isRenegotiating = true;
        const tracksToProcess = [...this.pendingRemoteTracks];
        this.pendingRemoteTracks = [];
        
        try {
            const res = await fetch(this.apiUrl + `/calls/sessions/${callsSessionId}/tracks/new`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tracks: tracksToProcess.map(t => {
                        const entry = { location: 'remote', sessionId: t.sessionId, trackName: t.trackName };
                        if (t.simulcastRid) entry.simulcastRid = t.simulcastRid;
                        return entry;
                    })
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.errorDescription || 'Subscription failed');

            if (data.sessionDescription && data.sessionDescription.type === 'offer') {
                if (data.tracks) {
                    data.tracks.forEach(t => {
                        if (t.mid) {
                            this.transceiversMap.set(t.mid, { 
                                location: t.location || 'remote', sessionId: t.sessionId, trackName: t.trackName 
                            });
                            this.subscribedTracks.add(t.sessionId + ':' + t.trackName);
                        }
                    });
                }

                await this.pc.setRemoteDescription(new RTCSessionDescription(data.sessionDescription));
                const answer = await this.pc.createAnswer();
                await this.pc.setLocalDescription(answer);
                
                await fetch(this.apiUrl + `/calls/sessions/${callsSessionId}/renegotiate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        sessionDescription: { type: 'answer', sdp: this.pc.localDescription.sdp }
                    })
                });
            }
        } catch (e) {
            console.error('[WebRTCManager] Subscription Error:', e);
            this.pendingRemoteTracks = [...tracksToProcess, ...this.pendingRemoteTracks];
        } finally {
            this.isRenegotiating = false;
            if (this.pendingRemoteTracks.length > 0) setTimeout(() => this.processPendingTracks(), 500);
        }
    }

    handleRemoteTracksUpdate(msg) {
        const sid = msg.sessionId || msg.clientId;
        if (!sid) return;
        console.info('[WebRTCManager] handleRemoteTracksUpdate from:', sid, 'tracks:', msg.tracks);

        // Build a set of all track names advertised by this remote peer
        const currentRemoteTracks = new Set(msg.tracks.map(t => sid + ':' + t.trackName));

        msg.tracks.forEach(t => {
            const key = sid + ':' + t.trackName;
            if (!this.subscribedTracks.has(key)) {
                if (!this.pendingRemoteTracks.some(p => p.sessionId === sid && p.trackName === t.trackName)) {
                    // For simulcast-capable video tracks, request the 'mid' layer by default
                    // to balance quality and bandwidth in multi-party scenarios
                    const pendingEntry = { sessionId: sid, trackName: t.trackName };
                    if (t.simulcast && t.trackName === 'video') {
                        pendingEntry.simulcastRid = this._selectSimulcastLayer(sid);
                    }
                    this.pendingRemoteTracks.push(pendingEntry);
                }
            }
        });

        // Remove tracks that the remote peer no longer advertises
        for (let key of Array.from(this.subscribedTracks)) {
            if (key.startsWith(sid + ':') && !currentRemoteTracks.has(key)) {
                this.subscribedTracks.delete(key);
                const trackName = key.split(':')[1];
                this.app.uiManager.removeRemoteTrackUI(sid, trackName, this.remoteStreams, this.subscribedTracks, this.pc, this.transceiversMap);
            }
        }

        if (this.pendingRemoteTracks.length > 0) this.processPendingTracks();
    }

    /**
     * Select the appropriate simulcast layer based on participant count.
     * Fewer participants → higher quality; more participants → lower quality.
     */
    _selectSimulcastLayer(excludeSessionId) {
        const participantCount = this._getRemoteParticipantCount(excludeSessionId);
        if (participantCount <= 2) return 'h';   // 1-on-1 or small call: high quality
        if (participantCount <= 4) return 'm';   // medium group: mid quality
        return 'l';                               // large group: low quality to save bandwidth
    }

    /**
     * Count unique remote participants currently subscribed or pending.
     */
    _getRemoteParticipantCount(excludeSessionId) {
        const sessions = new Set();
        for (const key of this.subscribedTracks) {
            const sid = key.split(':')[0];
            if (sid !== excludeSessionId) sessions.add(sid);
        }
        for (const entry of this.pendingRemoteTracks) {
            if (entry.sessionId !== excludeSessionId) sessions.add(entry.sessionId);
        }
        // +1 for the new participant being added
        return sessions.size + 1;
    }

    handleRemoteLeave(msg) {
        const sid = msg.sessionId || msg.clientId;
        if (!sid) return;
        console.info('[WebRTCManager] handleRemoteLeave from:', sid);
        for (let key of Array.from(this.subscribedTracks)) {
            if (key.startsWith(sid + ':')) {
                this.subscribedTracks.delete(key);
            }
        }
        
        this.app.uiManager.removeAllRemoteContainers(sid, this.remoteStreams);
        
        this.pc.getTransceivers().forEach(t => {
            const mapped = this.transceiversMap.get(t.mid);
            if (mapped && mapped.sessionId === sid) {
                t.direction = 'inactive';
                if (t.sender) t.sender.replaceTrack(null);
                this.transceiversMap.delete(t.mid);
            }
        });

        this.rebalanceSimulcastLayers();
    }

    async replaceVideoTrack(newTrack) {
        if (!this.pc) return;
        for (const t of this.pc.getTransceivers()) {
            const info = this.transceiversMap.get(t.mid);
            if (info && info.location === 'local' && info.trackName === 'video') {
                await t.sender.replaceTrack(newTrack);
                if (newTrack && newTrack.contentHint === 'detail') {
                    const params = t.sender.getParameters();
                    if (params.encodings) {
                        params.encodings.forEach(enc => {
                            enc.degradationPreference = 'maintain-resolution';
                        });
                        await t.sender.setParameters(params);
                    }
                }
            }
        }
        this.app.uiManager.updateLocalVideo(newTrack);
    }

    /**
     * Rebalance simulcast layers for all subscribed video tracks
     * based on the current number of participants.
     * Call this when participants join or leave.
     */
    async rebalanceSimulcastLayers() {
        if (!this.pc) return;
        const participantCount = this._getRemoteParticipantCount(null);
        let desiredRid;
        if (participantCount <= 2) desiredRid = 'h';
        else if (participantCount <= 4) desiredRid = 'm';
        else desiredRid = 'l';

        console.info('[WebRTCManager] Rebalancing simulcast to rid:', desiredRid, 'participants:', participantCount);
        // Note: actual layer selection is enforced server-side via the Calls API.
        // This updates client-side preference for future subscriptions.
        this._currentPreferredRid = desiredRid;
    }
    
    stopScreenTransceiver() {
        this.pc.getTransceivers().forEach(t => {
            const mapped = this.transceiversMap.get(t.mid);
            if (mapped && mapped.location === 'local' && mapped.trackName === 'screen') {
                t.direction = 'inactive';
                t.sender.replaceTrack(null);
                this.transceiversMap.delete(t.mid);
            }
        });
    }

    close() {
        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }
    }
}

window.WebRTCManager = WebRTCManager;
