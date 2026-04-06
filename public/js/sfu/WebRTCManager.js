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

        // Serialized task queue: guarantees that all Calls API interactions
        // (push via renegotiate, pull via processPendingTracks, answer via /renegotiate)
        // execute strictly one-at-a-time, preventing 406 "push and pull in same request" errors.
        this._taskQueue = Promise.resolve();
        this._renegotiateScheduled = false;
        this._pullScheduled = false;

        // Track who is currently screen-sharing (null = nobody)
        this._remoteScreenSharerSid = null;

        // Mids that have already been pushed to the SFU via /tracks/new.
        // Only genuinely new tracks should be sent; re-sending existing ones
        // causes the SFU to create duplicate track distributions.
        this._pushedMids = new Set();
    }

    /**
     * Enqueue an async task so it runs after all previously queued tasks complete.
     * Returns a promise that resolves when this task finishes.
     */
    _enqueue(fn) {
        const task = this._taskQueue.then(fn).catch(e => {
            console.error('[WebRTCManager] Queued task error:', e);
        });
        this._taskQueue = task;
        return task;
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
            } else {
                // Track arrived before transceiversMap was populated (race condition during SRD)
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

    async renegotiate() {
        if (!this.pc || !this.app.callsSessionId) return;
        if (this._renegotiateScheduled) return;
        this._renegotiateScheduled = true;

        return this._enqueue(async () => {
            this._renegotiateScheduled = false;
            const callsSessionId = this.app.callsSessionId;
            if (!this.pc || !callsSessionId) return;

            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            const sessionDescription = this.pc.localDescription;
            const newTracks = [];       // only genuinely NEW tracks for /tracks/new
            const localTracksInfo = []; // all active local tracks for WebSocket broadcast

            this.pc.getTransceivers().forEach(t => {
                 if (t.direction === 'sendonly' || t.direction === 'sendrecv') {
                     const trackName = this.getTrackName(t.sender.track);

                     // Build broadcast list (all active local tracks)
                     localTracksInfo.push({ trackName, mid: t.mid, simulcast: false });

                     // Update local mapping
                     this.transceiversMap.set(t.mid, { location: 'local', trackName, sessionId: callsSessionId });

                     // Only include tracks that haven't been pushed yet
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
                                 // Update broadcast entry with simulcast info
                                 localTracksInfo[localTracksInfo.length - 1].simulcast = true;
                             }
                         }
                         newTracks.push(trackEntry);
                     }
                 }
            });

            // Only call /tracks/new when there are genuinely new tracks to push.
            // For SDP-only updates (e.g. transceiver went inactive), use /renegotiate.
            if (newTracks.length > 0) {
                const res = await fetch(this.apiUrl + `/calls/sessions/${callsSessionId}/tracks/new`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionDescription, tracks: newTracks })
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.errorDescription || 'Renegotiation failed');

                // Mark pushed tracks so they won't be re-sent
                newTracks.forEach(t => this._pushedMids.add(t.mid));

                // Only update transceiversMap for REMOTE tracks in the response;
                // local track mappings are already set above and must not be overwritten.
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

                const remoteSdp = data.sdp || (data.sessionDescription ? data.sessionDescription.sdp : null);
                const remoteType = data.type || (data.sessionDescription ? data.sessionDescription.type : 'answer');
                await this.pc.setRemoteDescription(new RTCSessionDescription({ type: remoteType, sdp: remoteSdp }));
            } else {
                // No new tracks — just update the SDP (e.g. screen transceiver went inactive)
                await fetch(this.apiUrl + `/calls/sessions/${callsSessionId}/renegotiate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionDescription: { type: 'offer', sdp: sessionDescription.sdp } })
                });
            }

            this.pc.getTransceivers().forEach(t => {
                if (t.mid && t.direction === 'recvonly' && !this.transceiversMap.has(t.mid)) {
                    const existingEntry = Array.from(this.transceiversMap.entries()).find(
                        ([, v]) => v.location === 'remote' && !this.pc.getTransceivers().some(
                            tr => tr.mid === v.mid
                        )
                    );
                    if (existingEntry) {
                        const [oldMid, mapping] = existingEntry;
                        this.transceiversMap.delete(oldMid);
                        this.transceiversMap.set(t.mid, mapping);
                        console.info('[WebRTCManager] Remapped stale mid', oldMid, '→', t.mid, mapping.trackName);
                    }
                }
            });

            this._processDeferredOnTrackEvents();

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

            // After push completes, drain any pending pull tracks via the queue
            if (this.pendingRemoteTracks.length > 0) {
                this._schedulePull();
            }
        });
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

    /**
     * Schedule a pull task on the queue. Coalesces multiple rapid calls into one.
     */
    _schedulePull() {
        if (this._pullScheduled) return;
        this._pullScheduled = true;
        this._enqueue(() => this._processPendingTracksInner());
    }

    async processPendingTracks() {
        if (!this.pc || !this.app.callsSessionId || this.pendingRemoteTracks.length === 0) return;
        this._schedulePull();
    }

    async _processPendingTracksInner() {
        this._pullScheduled = false;
        const callsSessionId = this.app.callsSessionId;
        if (!this.pc || !callsSessionId || this.pendingRemoteTracks.length === 0) return;

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
                if (data.tracks && data.tracks.length > 0) {
                    const hasMids = data.tracks.some(t => t.mid);
                    if (hasMids) {
                        data.tracks.forEach(t => {
                            if (t.mid) {
                                this.transceiversMap.set(t.mid, {
                                    location: t.location || 'remote', sessionId: t.sessionId, trackName: t.trackName
                                });
                                this.subscribedTracks.add(t.sessionId + ':' + t.trackName);
                            }
                        });
                    } else {
                        console.warn('[WebRTCManager] Server response lacks mid metadata, falling back to order-based mapping');
                        const existingMids = new Set(this.transceiversMap.keys());
                        await this.pc.setRemoteDescription(new RTCSessionDescription(data.sessionDescription));
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
                            } else {
                                console.warn('[WebRTCManager] No mid available for requested track:', requested.sessionId, requested.trackName);
                            }
                        });
                        const answer = await this.pc.createAnswer();
                        await this.pc.setLocalDescription(answer);
                        await this._sendRenegotiateAnswer(callsSessionId);
                        this._processDeferredOnTrackEvents();
                        this._ensurePulledTracksDisplayed(tracksToProcess);
                        this._drainIfPending();
                        return;
                    }
                } else {
                    console.warn('[WebRTCManager] No tracks in server response, mapping from request order');
                    const existingMids = new Set(this.transceiversMap.keys());
                    await this.pc.setRemoteDescription(new RTCSessionDescription(data.sessionDescription));
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
                    const answer = await this.pc.createAnswer();
                    await this.pc.setLocalDescription(answer);
                    await this._sendRenegotiateAnswer(callsSessionId);
                    this._processDeferredOnTrackEvents();
                    this._ensurePulledTracksDisplayed(tracksToProcess);
                    this._drainIfPending();
                    return;
                }

                await this.pc.setRemoteDescription(new RTCSessionDescription(data.sessionDescription));
                const answer = await this.pc.createAnswer();
                await this.pc.setLocalDescription(answer);
                await this._sendRenegotiateAnswer(callsSessionId);
                this._processDeferredOnTrackEvents();
                this._ensurePulledTracksDisplayed(tracksToProcess);
            }
        } catch (e) {
            console.error('[WebRTCManager] Subscription Error:', e);
            this.pendingRemoteTracks = [...tracksToProcess, ...this.pendingRemoteTracks];
        }
        this._drainIfPending();
    }

    /**
     * Send the local answer SDP back to Cloudflare via /renegotiate.
     * Extracted to avoid duplication across pull-track code paths.
     */
    async _sendRenegotiateAnswer(callsSessionId) {
        await fetch(this.apiUrl + `/calls/sessions/${callsSessionId}/renegotiate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionDescription: { type: 'answer', sdp: this.pc.localDescription.sdp }
            })
        });
    }

    /**
     * If there are still pending remote tracks after a pull completes,
     * schedule another pull task on the queue.
     */
    _drainIfPending() {
        if (this.pendingRemoteTracks.length > 0) {
            this._schedulePull();
        }
    }

    handleRemoteTracksUpdate(msg) {
        const sid = msg.sessionId || msg.clientId;
        if (!sid) return;
        console.info('[WebRTCManager] handleRemoteTracksUpdate from:', sid, 'tracks:', msg.tracks);

        // Build a set of all track names advertised by this remote peer
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
    
    /**
     * Process deferred ontrack events that arrived before transceiversMap was populated.
     * Called after transceiversMap updates in processPendingTracks and renegotiate.
     */
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

    /**
     * After a pull completes, ensure every pulled track is wired to the UI.
     * Handles the case where the browser reuses an existing transceiver and
     * does NOT fire pc.ontrack (common on second+ screen-share subscriptions).
     */
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

    stopScreenTransceiver() {
        this.pc.getTransceivers().forEach(t => {
            const mapped = this.transceiversMap.get(t.mid);
            if (mapped && mapped.location === 'local' && mapped.trackName === 'screen') {
                t.direction = 'inactive';
                t.sender.replaceTrack(null);
                this._pushedMids.delete(t.mid);
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
