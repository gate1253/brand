class WebRTCManager {
    constructor(app, apiUrl) {
        this.app = app;
        this.apiUrl = apiUrl;
        this.pc = null;
        this.transceiversMap = new Map();
        this.subscribedTracks = new Set();
        this.remoteStreams = new Map(); // sessionId -> MediaStream
        this.pendingRemoteTracks = [];
        this._deferredOnTrackEvents = [];

        // FIFOScheduler pattern (from partytracks): guarantees strict
        // serial execution of all Calls API interactions.
        this._taskQueue = Promise.resolve();

        // Coalesce flags
        this._pushScheduled = false;
        this._pullScheduled = false;

        // Track who is currently screen-sharing (null = nobody)
        this._remoteScreenSharerSid = null;

        // Mids already pushed to SFU via /tracks/new.
        this._pushedMids = new Set();
    }

    // ── FIFOScheduler ─────────────────────────────────────────────

    _enqueue(fn) {
        const task = this._taskQueue.then(fn).catch(e => {
            console.error('[WebRTCManager] Queued task error:', e);
        });
        this._taskQueue = task;
        return task;
    }

    // ── signalingStateIsStable (partytracks pattern) ──────────────
    // After every push/pull/close, wait for the PeerConnection to
    // reach "stable" before allowing the next queued task to proceed.

    _waitForStableSignaling(timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            if (!this.pc || this.pc.signalingState === 'stable') {
                resolve();
                return;
            }
            const timeout = setTimeout(() => {
                this.pc.removeEventListener('signalingstatechange', handler);
                reject(new Error('Signaling state did not stabilize within ' + timeoutMs + 'ms'));
            }, timeoutMs);

            const handler = () => {
                if (this.pc.signalingState === 'stable') {
                    this.pc.removeEventListener('signalingstatechange', handler);
                    clearTimeout(timeout);
                    resolve();
                }
            };
            this.pc.addEventListener('signalingstatechange', handler);
        });
    }

    // ── Helpers ────────────────────────────────────────────────────

    getTrackName(track) {
        if (!track) return 'video';
        if (track.kind === 'audio') return 'audio';
        if (this.app.mediaManager.screenStream && this.app.mediaManager.screenStream.getVideoTracks().includes(track)) return 'screen';
        return 'video';
    }

    _extractSdp(data) {
        if (data.sessionDescription && data.sessionDescription.sdp) {
            return data.sessionDescription;
        }
        if (data.sdp) {
            return { type: data.type || 'answer', sdp: data.sdp };
        }
        return null;
    }

    // ── Init ──────────────────────────────────────────────────────

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
            } else {
                console.warn('[WebRTCManager] ontrack: no mapping for mid', mid, '— deferring');
                this._deferredOnTrackEvents.push({ mid, track: event.track, transceiver: event.transceiver });
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

    // ── Push: local tracks → SFU via /tracks/new (partytracks pattern) ──
    // Always sends offer SDP + local tracks. /renegotiate is NEVER used
    // for offers — only for sending answers after a pull.

    async pushLocalTracks() {
        if (!this.pc || !this.app.callsSessionId) return;
        if (this._pushScheduled) return;
        this._pushScheduled = true;

        return this._enqueue(async () => {
            this._pushScheduled = false;
            const callsSessionId = this.app.callsSessionId;
            if (!this.pc || !callsSessionId) return;

            // Collect new (unpushed) local tracks
            const newTracks = [];
            const localTracksInfo = [];

            this.pc.getTransceivers().forEach(t => {
                if (t.direction === 'sendonly' || t.direction === 'sendrecv') {
                    const trackName = this.getTrackName(t.sender.track);
                    localTracksInfo.push({ trackName, mid: t.mid, simulcast: false });
                    this.transceiversMap.set(t.mid, { location: 'local', trackName, sessionId: callsSessionId });

                    if (!this._pushedMids.has(t.mid)) {
                        const trackEntry = { location: 'local', mid: t.mid, trackName };
                        if (t.sender.track && t.sender.track.kind === 'video' && trackName !== 'screen') {
                            const params = t.sender.getParameters();
                            if (params.encodings && params.encodings.length > 1) {
                                trackEntry.simulcastEncodings = params.encodings.map(enc => ({
                                    rid: enc.rid,
                                    maxBitrate: enc.maxBitrate,
                                    scaleResolutionDownBy: enc.scaleResolutionDownBy
                                }));
                                localTracksInfo[localTracksInfo.length - 1].simulcast = true;
                            }
                        }
                        newTracks.push(trackEntry);
                    }
                }
            });

            if (newTracks.length === 0) return; // Nothing to push

            // Create offer and push via /tracks/new
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            const res = await fetch(this.apiUrl + `/calls/sessions/${callsSessionId}/tracks/new`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionDescription: {
                        type: this.pc.localDescription.type,
                        sdp: this.pc.localDescription.sdp
                    },
                    tracks: newTracks
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.errorDescription || 'Push tracks failed');

            newTracks.forEach(t => this._pushedMids.add(t.mid));

            if (data.tracks) {
                data.tracks.forEach(t => {
                    if (t.mid && !this._pushedMids.has(t.mid)) {
                        this.transceiversMap.set(t.mid, {
                            location: t.location || 'remote',
                            sessionId: t.sessionId,
                            trackName: t.trackName
                        });
                    }
                });
            }

            // Set answer SDP from server
            const answerSdp = this._extractSdp(data);
            if (answerSdp) {
                await this.pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
            }

            // Wait for stable signaling state (partytracks pattern)
            await this._waitForStableSignaling();

            this._processDeferredOnTrackEvents();

            // Broadcast track info to other participants
            if (this.app.signalingClient && this.app.signalingClient.isOpen()) {
                this.app.signalingClient.send({
                    type: 'tracks-update',
                    sessionId: callsSessionId,
                    clientId: callsSessionId,
                    tracks: localTracksInfo,
                    room: this.app.targetCode
                });
            }

            // If remote tracks are pending, schedule a pull
            if (this.pendingRemoteTracks.length > 0) {
                this._schedulePull();
            }
        });
    }

    // ── Pull: subscribe to remote tracks (partytracks pattern) ────
    // 1. POST /tracks/new with remote tracks (NO SDP)
    // 2. If requiresImmediateRenegotiation:
    //    - setRemoteDescription(offer from server)
    //    - createAnswer → setLocalDescription
    //    - PUT /renegotiate with answer
    //    - wait for stable

    _schedulePull() {
        if (this._pullScheduled) return;
        this._pullScheduled = true;
        this._enqueue(() => this._pullTracksInner());
    }

    async processPendingTracks() {
        if (!this.pc || !this.app.callsSessionId || this.pendingRemoteTracks.length === 0) return;
        this._schedulePull();
    }

    async _pullTracksInner() {
        this._pullScheduled = false;
        const callsSessionId = this.app.callsSessionId;
        if (!this.pc || !callsSessionId || this.pendingRemoteTracks.length === 0) return;

        const tracksToProcess = [...this.pendingRemoteTracks];
        this.pendingRemoteTracks = [];

        try {
            // Step 1: POST /tracks/new with remote tracks only (NO SDP — partytracks pattern)
            const existingMids = new Set(this.transceiversMap.keys());
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

            // Map returned track metadata
            if (data.tracks && data.tracks.length > 0) {
                data.tracks.forEach(t => {
                    if (t.mid) {
                        this.transceiversMap.set(t.mid, {
                            location: t.location || 'remote', sessionId: t.sessionId, trackName: t.trackName
                        });
                        this.subscribedTracks.add(t.sessionId + ':' + t.trackName);
                    }
                });
            }

            // Step 2: If requiresImmediateRenegotiation, complete the SDP handshake
            if (data.requiresImmediateRenegotiation) {
                const remoteSdp = this._extractSdp(data);

                // Server sent an offer — set it, create answer, send answer back
                await this.pc.setRemoteDescription(new RTCSessionDescription(remoteSdp));

                // Fallback: if no mids from server, map new recvonly transceivers by order
                if (!data.tracks || !data.tracks.some(t => t.mid)) {
                    console.warn('[WebRTCManager] Server response lacks mid metadata, falling back to order-based mapping');
                    const newRecvMids = [];
                    this.pc.getTransceivers().forEach(t => {
                        if (t.direction === 'recvonly' && t.mid && !existingMids.has(t.mid) && !this.transceiversMap.has(t.mid)) {
                            newRecvMids.push(t.mid);
                        }
                    });
                    tracksToProcess.forEach((requested, idx) => {
                        if (idx < newRecvMids.length) {
                            const mid = newRecvMids[idx];
                            this.transceiversMap.set(mid, {
                                location: 'remote', sessionId: requested.sessionId, trackName: requested.trackName
                            });
                            this.subscribedTracks.add(requested.sessionId + ':' + requested.trackName);
                            console.info('[WebRTCManager] Fallback mapped mid', mid, '→', requested.sessionId, requested.trackName);
                        }
                    });
                }

                const answer = await this.pc.createAnswer();
                await this.pc.setLocalDescription(answer);

                // Step 3: Send answer via /renegotiate (partytracks pattern — answer only)
                await this._sendRenegotiateAnswer(callsSessionId);

                // Step 4: Wait for stable signaling state
                await this._waitForStableSignaling();
            }

            this._processDeferredOnTrackEvents();
            this._ensurePulledTracksDisplayed(tracksToProcess);
        } catch (e) {
            console.error('[WebRTCManager] Subscription Error:', e);
            // Re-queue failed tracks for retry
            this.pendingRemoteTracks = [...tracksToProcess, ...this.pendingRemoteTracks];
        }

        // If more tracks arrived while we were processing, drain them
        this._drainIfPending();
    }

    async _sendRenegotiateAnswer(callsSessionId) {
        const res = await fetch(this.apiUrl + `/calls/sessions/${callsSessionId}/renegotiate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionDescription: {
                    type: 'answer',
                    sdp: this.pc.localDescription.sdp
                }
            })
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            console.error('[WebRTCManager] /renegotiate failed:', res.status, data.errorDescription || '');
            throw new Error(data.errorDescription || `Renegotiation failed (${res.status})`);
        }
    }

    _drainIfPending() {
        if (this.pendingRemoteTracks.length > 0) {
            this._schedulePull();
        }
    }

    // ── Backward-compatible alias ─────────────────────────────────
    // SFUApp.start() calls renegotiate() — redirect to pushLocalTracks

    async renegotiate() {
        return this.pushLocalTracks();
    }

    // ── Broadcast ─────────────────────────────────────────────────

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

    // ── Remote track handling ─────────────────────────────────────

    handleRemoteTracksUpdate(msg) {
        const sid = msg.sessionId || msg.clientId;
        if (!sid) return;
        console.info('[WebRTCManager] handleRemoteTracksUpdate from:', sid, 'tracks:', msg.tracks);

        const currentRemoteTracks = new Set(msg.tracks.map(t => sid + ':' + t.trackName));

        // Track remote screen share state
        const hasScreen = msg.tracks.some(t => t.trackName === 'screen');
        if (hasScreen) {
            this._remoteScreenSharerSid = sid;
        } else if (this._remoteScreenSharerSid === sid) {
            this._remoteScreenSharerSid = null;
        }
        this.app.uiManager.updateScreenShareLock();

        msg.tracks.forEach(t => {
            const key = sid + ':' + t.trackName;
            if (!this.subscribedTracks.has(key)) {
                if (!this.pendingRemoteTracks.some(p => p.sessionId === sid && p.trackName === t.trackName)) {
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

    _selectSimulcastLayer(excludeSessionId) {
        const participantCount = this._getRemoteParticipantCount(excludeSessionId);
        if (participantCount <= 2) return 'h';
        if (participantCount <= 4) return 'm';
        return 'l';
    }

    _getRemoteParticipantCount(excludeSessionId) {
        const sessions = new Set();
        for (const key of this.subscribedTracks) {
            const sid = key.split(':')[0];
            if (sid !== excludeSessionId) sessions.add(sid);
        }
        for (const entry of this.pendingRemoteTracks) {
            if (entry.sessionId !== excludeSessionId) sessions.add(entry.sessionId);
        }
        return sessions.size + 1;
    }

    handleRemoteLeave(msg) {
        const sid = msg.sessionId || msg.clientId;
        if (!sid) return;
        console.info('[WebRTCManager] handleRemoteLeave from:', sid);

        if (this._remoteScreenSharerSid === sid) {
            this._remoteScreenSharerSid = null;
            this.app.uiManager.updateScreenShareLock();
        }

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

    // ── Track replacement ─────────────────────────────────────────

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

    // ── Simulcast rebalancing ─────────────────────────────────────

    async rebalanceSimulcastLayers() {
        if (!this.pc) return;
        const participantCount = this._getRemoteParticipantCount(null);
        let desiredRid;
        if (participantCount <= 2) desiredRid = 'h';
        else if (participantCount <= 4) desiredRid = 'm';
        else desiredRid = 'l';

        console.info('[WebRTCManager] Rebalancing simulcast to rid:', desiredRid, 'participants:', participantCount);
        this._currentPreferredRid = desiredRid;
    }

    // ── Deferred ontrack handling ─────────────────────────────────

    _processDeferredOnTrackEvents() {
        if (this._deferredOnTrackEvents.length === 0) return;
        const remaining = [];
        for (const evt of this._deferredOnTrackEvents) {
            const mid = evt.transceiver.mid || evt.mid;
            const info = this.transceiversMap.get(mid);
            if (info && info.location === 'remote') {
                console.info('[WebRTCManager] Processing deferred ontrack for mid:', mid, info.trackName);
                this.app.uiManager.setupRemoteVideo(info, evt.track, this.remoteStreams);
            } else {
                remaining.push(evt);
            }
        }
        this._deferredOnTrackEvents = remaining;
    }

    _ensurePulledTracksDisplayed(tracksToProcess) {
        for (const requested of tracksToProcess) {
            for (const [mid, info] of this.transceiversMap.entries()) {
                if (info.location === 'remote' && info.sessionId === requested.sessionId && info.trackName === requested.trackName) {
                    const transceiver = this.pc.getTransceivers().find(t => t.mid === mid);
                    if (transceiver && transceiver.receiver && transceiver.receiver.track) {
                        console.info('[WebRTCManager] Ensuring pulled track is displayed:', mid, info.trackName);
                        this.app.uiManager.setupRemoteVideo(info, transceiver.receiver.track, this.remoteStreams);
                    }
                }
            }
        }
    }

    isRemoteScreenSharing() {
        return this._remoteScreenSharerSid !== null;
    }

    // ── Close screen track (partytracks pattern) ──────────────────

    async closeScreenTrack() {
        return this._enqueue(async () => {
            const callsSessionId = this.app.callsSessionId;
            if (!this.pc || !callsSessionId) return;

            const midsToClose = [];
            this.pc.getTransceivers().forEach(t => {
                const mapped = this.transceiversMap.get(t.mid);
                if (mapped && mapped.location === 'local' && mapped.trackName === 'screen') {
                    midsToClose.push(t.mid);
                    t.stop();
                }
            });

            if (midsToClose.length === 0) return;
            console.info('[WebRTCManager] closeScreenTrack mids:', midsToClose);

            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            const res = await fetch(this.apiUrl + `/calls/sessions/${callsSessionId}/tracks/close`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tracks: midsToClose.map(mid => ({ mid })),
                    sessionDescription: {
                        type: 'offer',
                        sdp: this.pc.localDescription.sdp
                    },
                    force: false
                })
            });

            const data = await res.json();

            if (res.ok) {
                const answerSdp = this._extractSdp(data);
                if (answerSdp) {
                    await this.pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
                }
                // Wait for stable (partytracks pattern)
                await this._waitForStableSignaling();
            }

            // Clean up maps
            midsToClose.forEach(mid => {
                this._pushedMids.delete(mid);
                this.transceiversMap.delete(mid);
            });

            // Broadcast updated tracks
            if (this.app.signalingClient && this.app.signalingClient.isOpen()) {
                const localTracksInfo = [];
                this.pc.getTransceivers().forEach(t => {
                    if ((t.direction === 'sendonly' || t.direction === 'sendrecv') && t.sender.track) {
                        localTracksInfo.push({ trackName: this.getTrackName(t.sender.track), mid: t.mid });
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
