class WebRTCUIManager {
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
        this.colorPickerBtn = document.getElementById('colorPickerBtn');
        this.bgColorInput = document.getElementById('bgColorInput');

        this.isMicOn = true;
        this.isVideoOn = true;

        this.bindEvents();
    }

    setStatus(text, type) {
        this.statusMsg.textContent = text;
        this.statusDot.className = 'dot' + (type === 'success' ? '' : ' ' + type);
    }

    updateUserCount(count) {
        this.userCountBadge.textContent = count + ' Participants';
    }

    bindEvents() {
        this.toggleMicBtn.onclick = () => {
            const localStream = this.app.mediaManager.getLocalStream();
            if (!localStream) return;
            this.isMicOn = !this.isMicOn;
            localStream.getAudioTracks().forEach(track => track.enabled = this.isMicOn);
            this.toggleMicBtn.classList.toggle('off', !this.isMicOn);
        };

        this.toggleVideoBtn.onclick = () => {
            const localStream = this.app.mediaManager.getLocalStream();
            if (!localStream) return;
            this.isVideoOn = !this.isVideoOn;
            localStream.getVideoTracks().forEach(track => track.enabled = this.isVideoOn);
            this.toggleVideoBtn.classList.toggle('off', !this.isVideoOn);
            document.getElementById('localVideoContainer').classList.toggle('no-video', !this.isVideoOn);
        };

        this.toggleScreenBtn.onclick = async () => {
            if (this.app.mediaManager.screenStream) {
                this.app.peerManager.stopScreenSharing();
            } else {
                try {
                    await this.app.peerManager.startScreenSharing();
                    this.toggleScreenBtn.classList.add('active');
                } catch (e) {
                    console.error('Screen share failed:', e);
                    this.toggleScreenBtn.classList.remove('active');
                }
            }
        };

        this.toggleBlurBtn.onclick = (e) => {
            e.stopPropagation();
            this.bgMenu.classList.toggle('show');
        };

        document.querySelectorAll('.bg-option').forEach(opt => {
            opt.onclick = async () => {
                document.querySelectorAll('.bg-option').forEach(el => el.classList.remove('active'));
                opt.classList.add('active');

                const type = opt.dataset.type;
                const value = opt.dataset.value;

                const stream = await this.app.mediaManager.applyBgFilter(type, value);
                if (type === 'none') {
                    this.toggleBlurBtn.classList.remove('active');
                } else {
                    this.toggleBlurBtn.classList.add('active');
                }
                this.app.mediaManager.replaceVideoTrack(stream);
            };
        });

        this.colorPickerBtn.onclick = (e) => {
            e.stopPropagation();
            this.bgColorInput.click();
        };

        this.bgColorInput.oninput = async () => {
            const stream = await this.app.mediaManager.applyBgFilter('color', this.bgColorInput.value);
            this.toggleBlurBtn.classList.add('active');
            this.app.mediaManager.replaceVideoTrack(stream);
        };

        window.onclick = () => this.bgMenu.classList.remove('show');
        this.bgMenu.onclick = (e) => e.stopPropagation();

        this.leaveBtn.onclick = () => {
            if (confirm('회의를 종료하시겠습니까?')) {
                this.app.destroy();
                document.body.innerHTML = '<div style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;gap:20px;">' +
                    '<h1 style="font-size:32px;font-weight:600;">회의가 종료되었습니다</h1>' +
                    '<button onclick="location.reload()" style="padding:12px 24px;border-radius:12px;border:none;background:var(--primary);color:white;cursor:pointer;font-family:inherit;">다시 참여하기</button>' +
                    '</div>';
            }
        };
    }

    updatePeerVideo(peerId, stream) {
        const isScreen = peerId.toString().includes('_screen');
        const containerId = 'container-' + peerId;
        let container = document.getElementById(containerId);

        if (!container) {
            container = document.createElement('div');
            container.id = containerId;
            container.className = 'video-container no-video';
            container.setAttribute('data-initials', isScreen ? 'S' : 'P');

            const video = document.createElement('video');
            video.id = 'video-' + peerId;
            video.autoplay = true;
            video.playsinline = true;
            if (isScreen) {
                container.classList.add('screen-share-mode');
                video.style.objectFit = 'contain';
                video.style.transform = 'none';
                container.onclick = () => container.classList.toggle('expanded');
            }

            const label = document.createElement('div');
            label.className = 'label';
            label.textContent = isScreen ? 'Screen Share' : 'Participant';

            const badge = document.createElement('div');
            badge.id = 'badge-' + peerId;
            badge.className = 'status-badge';
            badge.textContent = 'connecting';

            container.appendChild(video);
            container.appendChild(label);
            container.appendChild(badge);
            this.videoGrid.appendChild(container);
        }

        if (stream) {
            const video = document.getElementById('video-' + peerId);
            video.srcObject = stream;
            const hasVideo = stream.getVideoTracks().length > 0;
            if (hasVideo) container.classList.remove('no-video');
        }
    }

    removePeerVideoContainer(peerId) {
        const container = document.getElementById('container-' + peerId);
        if (container) {
            container.style.opacity = '0';
            container.style.transform = 'scale(0.8)';
            setTimeout(() => container.remove(), 500);
        }
    }
}

window.WebRTCUIManager = WebRTCUIManager;
