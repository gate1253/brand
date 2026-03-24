class MediaManager {
    constructor(app) {
        this.app = app;
        this.localStream = null;
        this.cameraStream = null;
        this.screenStream = null;
        this.processedStream = null;
        this.activeStreamType = 'camera';
        
        this.isMicOn = true;
        this.isVideoOn = true;
        
        this.currentBgMode = 'none';
        this.currentBgValue = '';
        this.isProcessingBg = false;
        this.bgSourceVideo = null;
        
        this.bgImageObj = new Image();
        this.bgImageObj.crossOrigin = "anonymous";
        
        this.selfieSegmentation = null;
        this.procCanvas = document.getElementById('procCanvas');
        this.ctx = this.procCanvas ? this.procCanvas.getContext('2d') : null;
    }

    async initCamera() {
        this.cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 360 } },
            audio: true
        });
        this.localStream = this.cameraStream;
        return this.localStream;
    }

    toggleMic() {
        this.isMicOn = !this.isMicOn;
        if (this.localStream) {
            this.localStream.getAudioTracks().forEach(t => t.enabled = this.isMicOn);
        }
        return this.isMicOn;
    }

    toggleVideo() {
        this.isVideoOn = !this.isVideoOn;
        if (this.cameraStream) {
            this.cameraStream.getVideoTracks().forEach(t => t.enabled = this.isVideoOn);
        }
        return this.isVideoOn;
    }

    async toggleScreen() {
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(t => t.stop());
            this.screenStream = null;
            return { active: false, stream: null };
        } else {
            this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            this.screenStream.getVideoTracks()[0].onended = () => {
                if (this.app.uiManager) this.app.uiManager.triggerScreenToggle();
            };
            return { active: true, stream: this.screenStream };
        }
    }

    setBgMode(type, value) {
        this.currentBgMode = type;
        this.currentBgValue = value;
        if (type === 'image') this.bgImageObj.src = value;
    }

    async applyBgFilter() {
        if (this.currentBgMode === 'none') {
            this.activeStreamType = 'camera';
            if (this.cameraStream && this.cameraStream.getVideoTracks().length > 0) {
                return this.cameraStream.getVideoTracks()[0];
            }
            return null;
        }

        await this.processBg();

        if (this.activeStreamType !== 'canvas' && this.procCanvas) {
            this.activeStreamType = 'canvas';
            this.processedStream = this.procCanvas.captureStream(30);
            return this.processedStream.getVideoTracks()[0];
        }
        return null;
    }

    initSelfieSegmentation() {
        if (this.selfieSegmentation) return;
        this.selfieSegmentation = new SelfieSegmentation({
            locateFile: (file) => 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/' + file
        });
        this.selfieSegmentation.setOptions({ modelSelection: 1, selfieMode: false });
        this.selfieSegmentation.onResults(this.onSegmentationResults.bind(this));
    }

    onSegmentationResults(results) {
        if (this.currentBgMode === 'none' || !this.ctx) return;
        const width = results.image.width;
        const height = results.image.height;
        this.procCanvas.width = width;
        this.procCanvas.height = height;
        
        this.ctx.save();
        this.ctx.clearRect(0, 0, width, height);

        this.ctx.filter = 'blur(1px) contrast(5) brightness(1.1) blur(0.5px)';
        this.ctx.drawImage(results.segmentationMask, 0, 0, width, height);
        this.ctx.filter = 'none';

        this.ctx.globalCompositeOperation = 'source-in';
        this.ctx.drawImage(results.image, 0, 0, width, height);

        this.ctx.globalCompositeOperation = 'destination-over';
        if (this.currentBgMode === 'blur') {
            this.ctx.filter = 'blur(15px) brightness(1.1)';
            this.ctx.drawImage(results.image, 0, 0, width, height);
            this.ctx.filter = 'none';
        } else if (this.currentBgMode === 'color') {
            this.ctx.fillStyle = this.currentBgValue;
            this.ctx.fillRect(0, 0, width, height);
        } else if (this.currentBgMode === 'image') {
            if (this.bgImageObj.complete) {
                this.ctx.drawImage(this.bgImageObj, 0, 0, width, height);
            } else {
                this.ctx.fillStyle = '#000';
                this.ctx.fillRect(0, 0, width, height);
            }
        }
        this.ctx.restore();
    }

    async processBg() {
        if (!this.cameraStream) return;
        
        if (!this.bgSourceVideo) {
            this.bgSourceVideo = document.createElement('video');
            this.bgSourceVideo.muted = true;
            this.bgSourceVideo.playsInline = true;
        }

        if (this.bgSourceVideo.srcObject !== this.cameraStream) {
            this.bgSourceVideo.srcObject = this.cameraStream;
            await this.bgSourceVideo.play();
        }

        if (this.isProcessingBg) return;
        this.isProcessingBg = true;
        
        this.initSelfieSegmentation();

        const sendToMediaPipe = async () => {
            if (this.currentBgMode === 'none') {
                this.isProcessingBg = false;
                return;
            }
            try {
                await this.selfieSegmentation.send({ image: this.bgSourceVideo });
            } catch (e) {
                console.error("[MediaManager] MediaPipe error:", e);
            }
            if (this.isProcessingBg) {
                requestAnimationFrame(sendToMediaPipe);
            }
        };
        sendToMediaPipe();
    }
    
    stopAll() {
        if (this.localStream) this.localStream.getTracks().forEach(track => track.stop());
        if (this.screenStream) this.screenStream.getTracks().forEach(track => track.stop());
    }
}

window.MediaManager = MediaManager;
