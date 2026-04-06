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

            // Ensure PC is in stable state before starting a new negotiation.
            // If a previous renegotiate left the PC in have-local-offer (e.g. due
            // to a concurrent stopScreenTransceiver modifying transceivers), roll back.
            if (this.pc.signalingState !== 'stable') {
                console.warn('[WebRTCManager] renegotiate: signalingState is', this.pc.signalingState, '— rolling back');
                await this.pc.setLocalDescription({ type: 'rollback' });
            }

            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            const sessionDescription = {
                type: this.pc.localDescription.type,
                sdp: this.pc.localDescription.sdp
            };
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

            console.info('[PUSH-DEBUG] newTracks:', newTracks.length, newTracks.map(t => t.trackName));
            console.info('[PUSH-DEBUG] signalingState:', this.pc.signalingState);

            if (newTracks.length > 0) {
                // Push new tracks via /tracks/new (always include full SDP)
                const res = await fetch(this.apiUrl + `/calls/sessions/${callsSessionId}/tracks/new`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionDescription, tracks: newTracks })
                });
                const data = await res.json();
                console.info('[PUSH-DEBUG] /tracks/new 응답 status:', res.status);
                console.info('[PUSH-DEBUG] sessionDescription.type:', data.sessionDescription?.type);
                console.info('[PUSH-DEBUG] requiresImmediateRenegotiation:', data.requiresImmediateRenegotiation);
                console.info('[PUSH-DEBUG] 응답 키:', Object.keys(data));

                if (!res.ok) throw new Error(data.errorDescription || 'Renegotiation failed');

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

                const answerSdp = this._extractSdp(data);
                console.info('[PUSH-DEBUG] answerSdp extracted:', !!answerSdp, answerSdp?.type);
                if (answerSdp) {
                    await this.pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
                    console.info('[PUSH-DEBUG] setRemoteDescription 완료, signalingState:', this.pc.signalingState);
                } else {
                    console.error('[PUSH-DEBUG] ❌ SDP 추출 실패! data.sessionDescription:', !!data.sessionDescription, 'data.sdp:', !!data.sdp);
                }
            } else {
                // No new tracks — SDP-only update via /renegotiate
                // (e.g. screen transceiver went inactive)
                console.info('[PUSH-DEBUG] SDP-only /renegotiate (no new tracks)');
                const res = await fetch(this.apiUrl + `/calls/sessions/${callsSessionId}/renegotiate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionDescription })
                });
                const data = await res.json();
                console.info('[PUSH-DEBUG] /renegotiate 응답 status:', res.status, 'body:', JSON.stringify(data).substring(0, 200));
                if (!res.ok) {
                    console.error('[PUSH-DEBUG] ❌ /renegotiate 실패:', res.status);
                    return; // Don't throw — let the queue continue
                }
                const answerSdp = this._extractSdp(data);
                if (answerSdp) {
                    await this.pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
                }
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
                this.app.signalingClient.send({
                    type: 'tracks-update',
                    sessionId: callsSessionId,
                    clientId: callsSessionId,
                    tracks: localTracksInfo,
                    room: this.app.targetCode
                });
            }

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
            const pullRequestBody = {
                tracks: tracksToProcess.map(t => {
                    const entry = { location: 'remote', sessionId: t.sessionId, trackName: t.trackName };
                    if (t.simulcastRid) entry.simulcastRid = t.simulcastRid;
                    return entry;
                })
            };
            console.info('[PULL-DEBUG] ① /tracks/new 요청:', JSON.stringify(pullRequestBody));
            console.info('[PULL-DEBUG] ① signalingState:', this.pc.signalingState);

            const res = await fetch(this.apiUrl + `/calls/sessions/${callsSessionId}/tracks/new`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pullRequestBody)
            });
            const data = await res.json();
            console.info('[PULL-DEBUG] ② /tracks/new 응답 status:', res.status);
            console.info('[PULL-DEBUG] ② requiresImmediateRenegotiation:', data.requiresImmediateRenegotiation);
            console.info('[PULL-DEBUG] ② sessionDescription.type:', data.sessionDescription?.type);
            console.info('[PULL-DEBUG] ② tracks:', JSON.stringify(data.tracks));
            console.info('[PULL-DEBUG] ② 전체 응답 키:', Object.keys(data));

            if (!res.ok) throw new Error(data.errorDescription || 'Subscription failed');

            // Map returned track metadata (mid assignments from server)
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

            // Following Cloudflare partytracks pattern: only renegotiate
            // when the server explicitly requires it.
            if (data.requiresImmediateRenegotiation) {
                console.info('[PULL-DEBUG] ③ renegotiation 필요 — SDP 교환 시작');
                const existingMids = new Set(this.transceiversMap.keys());
                const remoteSdp = this._extractSdp(data);
                console.info('[PULL-DEBUG] ③ remoteSdp.type:', remoteSdp?.type);

                await this.pc.setRemoteDescription(
                    new RTCSessionDescription(remoteSdp)
                );
                console.info('[PULL-DEBUG] ④ setRemoteDescription 완료, signalingState:', this.pc.signalingState);

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
                console.info('[PULL-DEBUG] ⑤ answer 생성 완료, signalingState:', this.pc.signalingState);
                await this._sendRenegotiateAnswer(callsSessionId);
                console.info('[PULL-DEBUG] ⑥ /renegotiate 완료, signalingState:', this.pc.signalingState);
            } else {
                console.info('[PULL-DEBUG] ③ renegotiation 불필요 (requiresImmediateRenegotiation=false)');
            }

            this._processDeferredOnTrackEvents();
            this._ensurePulledTracksDisplayed(tracksToProcess);
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
        const answerSdp = this.pc.localDescription.sdp;
        console.info('[RENEG-DEBUG] /renegotiate 요청 — type: answer, sdp 길이:', answerSdp?.length);
        console.info('[RENEG-DEBUG] signalingState:', this.pc.signalingState);
        console.info('[RENEG-DEBUG] localDescription.type:', this.pc.localDescription?.type);
        console.info('[RENEG-DEBUG] currentLocalDescription.type:', this.pc.currentLocalDescription?.type);

        const res = await fetch(this.apiUrl + `/calls/sessions/${callsSessionId}/renegotiate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionDescription: {
                    type: 'answer',
                    sdp: answerSdp
                }
            })
        });

        const responseBody = await res.json().catch(() => ({}));
        console.info('[RENEG-DEBUG] /renegotiate 응답 status:', res.status);
        console.info('[RENEG-DEBUG] 응답 body:', JSON.stringify(responseBody));

        if (!res.ok) {
            console.error('[RENEG-DEBUG] ❌ /renegotiate 실패:', res.status, responseBody.errorDescription || '');
            throw new Error(responseBody.errorDescription || `Renegotiation failed (${res.status})`);
        }
    }

    /**
     * Extract SDP from server response, handling both formats:
     * { sessionDescription: { type, sdp } } or { type, sdp }
     */
    _extractSdp(data) {
        if (data.sessionDescription && data.sessionDescription.sdp) {
            return data.sessionDescription;
        }
        if (data.sdp) {
            return { type: data.type || 'answer', sdp: data.sdp };
        }
        return null;
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

    /**
     * Close the screen share track via /tracks/close (Cloudflare partytracks pattern).
     * This replaces the old stopScreenTransceiver + renegotiate combo that caused 406.
     */
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
            console.info('[WebRTCManager] Closing screen track mids:', midsToClose);

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
            console.info('[WebRTCManager] /tracks/close response:', res.status);

            if (res.ok) {
                const answerSdp = this._extractSdp(data);
                if (answerSdp) {
                    await this.pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
                }
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
