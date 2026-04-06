class UIManager {
    constructor(app) {
        this.app = app;
        
        this.videoGrid = document.getElementById('videoGrid');
        this.localVideo = document.getElementById('localVideo');
        this.statusMsg = document.querySelector('#status span');
        this.statusDot = document.querySelector('#status .dot');
        this.userCountBadge = document.getElementById('userCount');
        
        this.toggleMicBtn = document.getElementById('toggleMic');
        this.toggleVideoBtn = document.getElementById('toggleVideo');
        this.toggleScreenBtn = document.getElementById('toggleScreen');
        this.toggleBlurBtn = document.getElementById('toggleBlur');
        this.leaveBtn = document.getElementById('leaveBtn');
        this.bgMenu = document.getElementById('bgMenu');
        this.bgOptions = document.querySelectorAll('.bg-option');
        
        this.bindEvents();
        this._injectSpeakingStyles();
    }

    bindEvents() {
        this.toggleMicBtn.onclick = () => {
            const isOn = this.app.mediaManager.toggleMic();
            this.toggleMicBtn.classList.toggle('active', isOn);
            this.toggleMicBtn.classList.toggle('off', !isOn);
        };

        this.toggleVideoBtn.onclick = () => {
            const isOn = this.app.mediaManager.toggleVideo();
            this.toggleVideoBtn.classList.toggle('active', isOn);
            this.toggleVideoBtn.classList.toggle('off', !isOn);
            document.getElementById('localVideoContainer').classList.toggle('no-video', !isOn);
        };

        this.toggleScreenBtn.onclick = async () => {
            const { active, stream } = await this.app.mediaManager.toggleScreen();
            
            if (!active) {
                this.toggleScreenBtn.classList.remove('active');
                this.app.webrtcManager.stopScreenTransceiver();
                
                // Remove local preview
                const localScreenContainer = document.getElementById('container-local-screen');
                if (localScreenContainer) localScreenContainer.remove();

                await this.app.webrtcManager.renegotiate();
            } else {
                this.toggleScreenBtn.classList.add('active');
                
                // Add local preview
                this.renderLocalScreenPreview(stream);

                this.app.webrtcManager.pc.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly' });
                await this.app.webrtcManager.renegotiate();
            }
        };

        this.toggleBlurBtn.onclick = (e) => { 
            e.stopPropagation(); 
            this.bgMenu.classList.toggle('show'); 
        };

        window.onclick = () => this.bgMenu.classList.remove('show');
        this.bgMenu.onclick = (e) => e.stopPropagation();

        this.bgOptions.forEach(opt => {
            opt.onclick = async () => {
                this.bgOptions.forEach(el => el.classList.remove('active'));
                opt.classList.add('active');
                
                const type = opt.dataset.type;
                const value = opt.dataset.value;
                this.app.mediaManager.setBgMode(type, value);
                
                const newTrack = await this.app.mediaManager.applyBgFilter();
                if (newTrack) {
                    this.app.webrtcManager.replaceVideoTrack(newTrack);
                }
            };
        });

        this.leaveBtn.onclick = () => this.handleLeave();
    }

    triggerScreenToggle() {
        this.toggleScreenBtn.click();
    }

    setStatus(text, type = 'normal') {
        this.statusMsg.textContent = text;
        if (type === 'error') {
            this.statusDot.className = 'dot error';
        } else if (type === 'warning') {
            this.statusDot.className = 'dot warning';
        } else {
            this.statusDot.className = 'dot';
        }
    }

    updateUserCount(count) {
        this.userCountBadge.textContent = count + ' Participants';
    }

    updateLocalVideo(track) {
        this.localVideo.srcObject = new MediaStream([track]);
    }

    renderLocalScreenPreview(stream) {
        let container = document.getElementById('container-local-screen');
        if (!container) {
            container = document.createElement('div');
            container.id = 'container-local-screen';
            container.className = 'video-container screen-share-mode';
            container.innerHTML = `
                <video id="localScreenVideo" autoplay playsinline muted></video>
                <div class="label">My Screen Share (Preview)</div>`;
            this.videoGrid.appendChild(container);
        }
        
        const video = document.getElementById('localScreenVideo');
        if (video) {
            video.srcObject = stream;
        }
    }

    createVideoContainer(sessionId, isScreen) {
        let id = 'container-' + sessionId;
        if (isScreen) id += '-screen';
        
        const container = document.createElement('div');
        container.id = id;
        container.className = 'video-container no-video';
        if (isScreen) container.classList.add('screen-share-mode');
        container.innerHTML = `
            <video id="video-${sessionId}${isScreen ? '-screen' : ''}" autoplay playsinline></video>
            <div class="label">${isScreen ? 'Screen Share' : 'Participant'}</div>`;
        
        this.videoGrid.appendChild(container);
        return container;
    }

    setupRemoteVideo(info, track, remoteStreamsMap) {
        console.info('[UIManager] setupRemoteVideo:', info.sessionId, info.trackName);
        let containerId = 'container-' + info.sessionId;
        if (info.trackName === 'screen') containerId += '-screen';
        
        let container = document.getElementById(containerId);
        if (!container) {
             container = this.createVideoContainer(info.sessionId, info.trackName === 'screen');
        }
        
        const videoId = 'video-' + info.sessionId + (info.trackName === 'screen' ? '-screen' : '');
        const video = document.getElementById(videoId);
        if (video) {
            const streamId = info.sessionId + (info.trackName === 'screen' ? '-screen' : '');
            let stream = remoteStreamsMap.get(streamId);
            if (!stream) {
                stream = new MediaStream();
                remoteStreamsMap.set(streamId, stream);
            }
            
            if (!stream.getTracks().some(t => t.id === track.id)) {
                console.info('[UIManager] Adding track to stream:', info.trackName, track.id);
                stream.addTrack(track);
            }

            if (video.srcObject !== stream) {
                video.srcObject = stream;
            }
            
            video.play().catch(e => {
                if (e.name !== 'AbortError') console.error("[UIManager] Video play failed:", e);
            });
            
            container.classList.remove('no-video');
        }
    }

    removeRemoteTrackUI(sid, trackName, remoteStreamsMap, subscribedTracksMap, pc, transceiversMap) {
        console.info('[UIManager] removeRemoteTrackUI:', sid, trackName);
        const streamId = sid + (trackName === 'screen' ? '-screen' : '');
        const stream = remoteStreamsMap.get(streamId);
        
        if (stream) {
            const kind = (trackName === 'audio') ? 'audio' : 'video';
            stream.getTracks().forEach(t => {
                if (t.kind === kind) {
                    console.info('[UIManager] Stopping and removing track:', kind, t.id);
                    t.stop();
                    stream.removeTrack(t);
                }
            });
        }

        let hasOtherTracks = false;
        if (trackName === 'screen') {
            hasOtherTracks = subscribedTracksMap.has(sid + ':screen');
        } else {
            hasOtherTracks = subscribedTracksMap.has(sid + ':video') || subscribedTracksMap.has(sid + ':audio');
        }

        if (!hasOtherTracks) {
            console.info('[UIManager] Removing container as no tracks remain:', streamId);
            let id = 'container-' + sid;
            if (trackName === 'screen') id += '-screen';
            const el = document.getElementById(id);
            if (el) el.remove();
            remoteStreamsMap.delete(streamId);
        }
        
        if (pc) {
            pc.getTransceivers().forEach(t => {
                const mapped = transceiversMap.get(t.mid);
                if (mapped && mapped.sessionId === sid && mapped.trackName === trackName) {
                    t.direction = 'inactive';
                    transceiversMap.delete(t.mid);
                }
            });
        }
    }
    
    removeAllRemoteContainers(sid, remoteStreamsMap) {
        const containers = document.querySelectorAll(`[id^="container-${sid}"]`);
        containers.forEach(c => c.remove());
        remoteStreamsMap.delete(sid);
        remoteStreamsMap.delete(sid + '-screen');
    }

    _injectSpeakingStyles() {
        if (document.getElementById('speaking-styles')) return;
        const style = document.createElement('style');
        style.id = 'speaking-styles';
        style.textContent = `
            .video-container.speaking {
                box-shadow: 0 0 0 3px #22c55e, 0 0 12px rgba(34, 197, 94, 0.4);
                border-radius: 8px;
                transition: box-shadow 0.2s ease;
            }
        `;
        document.head.appendChild(style);
    }

    handleSpeakerUpdate(sessionId, isSpeaking) {
        let container;
        if (sessionId === 'local') {
            container = document.getElementById('localVideoContainer');
        } else {
            container = document.getElementById('container-' + sessionId);
        }
        if (!container) return;

        if (isSpeaking) {
            container.classList.add('speaking');
        } else {
            container.classList.remove('speaking');
        }
    }

    handleLeave() {
        if (confirm('Exit?')) {
            this.app.destroy();

            this.videoGrid.innerHTML = '';
            this.setStatus('Disconnected', 'error');

            const rejoinBtn = document.createElement('button');
            rejoinBtn.textContent = 'Rejoin';
            rejoinBtn.style.padding = '10px 20px';
            rejoinBtn.style.fontSize = '16px';
            rejoinBtn.style.marginTop = '20px';
            rejoinBtn.style.cursor = 'pointer';
            rejoinBtn.style.background = '#4f46e5';
            rejoinBtn.style.color = 'white';
            rejoinBtn.style.border = 'none';
            rejoinBtn.style.borderRadius = '8px';
            rejoinBtn.onclick = () => location.reload();

            const msgContainer = document.createElement('div');
            msgContainer.style.position = 'fixed';
            msgContainer.style.top = '50%';
            msgContainer.style.left = '50%';
            msgContainer.style.transform = 'translate(-50%, -50%)';
            msgContainer.style.textAlign = 'center';
            msgContainer.style.color = 'white';
            msgContainer.innerHTML = '<h1>Session Ended</h1>';
            msgContainer.appendChild(rejoinBtn);

            document.body.appendChild(msgContainer);
            document.getElementById('controls').style.display = 'none';
            document.getElementById('header').style.display = 'none';
        }
    }
}

window.UIManager = UIManager;
