class WebRTCMediaManager {
    constructor(app) {
        this.app = app;
        this.cameraStream = null;
        this.screenStream = null;
        this.processedStream = null;
        this.activeStreamType = 'camera'; // 'camera', 'screen', 'canvas'
        this.currentBgMode = 'none';
        this.currentBgValue = '';
        this.bgImageObj = new Image();
        this.bgImageObj.crossOrigin = 'anonymous';
        this.selfieSegmentation = null;

        this.procCanvas = document.getElementById('procCanvas');
        this.ctx = this.procCanvas.getContext('2d');
    }

    async initCamera() {
        this.cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: true
        }).catch(async (e) => {
            console.warn('Camera/Mic failed:', e);
            return await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
        });
        return this.cameraStream;
    }

    getLocalStream() {
        if (this.activeStreamType === 'canvas' && this.processedStream) return this.processedStream;
        return this.cameraStream;
    }

    initSelfieSegmentation() {
        if (this.selfieSegmentation) return;
        this.selfieSegmentation = new SelfieSegmentation({
            locateFile: (file) => 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/' + file
        });
        this.selfieSegmentation.setOptions({ modelSelection: 1, selfieMode: false });
        this.selfieSegmentation.onResults((results) => this.onSegmentationResults(results));
    }

    onSegmentationResults(results) {
        if (this.currentBgMode === 'none') return;
        const { procCanvas, ctx } = this;
        procCanvas.width = results.image.width;
        procCanvas.height = results.image.height;

        ctx.save();
        ctx.clearRect(0, 0, procCanvas.width, procCanvas.height);

        const maskCtx = results.segmentationMask;
        ctx.filter = 'blur(1px) contrast(5) brightness(1.1) blur(0.5px)';
        ctx.drawImage(maskCtx, 0, 0, procCanvas.width, procCanvas.height);
        ctx.filter = 'none';

        ctx.globalCompositeOperation = 'source-in';
        ctx.drawImage(results.image, 0, 0, procCanvas.width, procCanvas.height);

        ctx.globalCompositeOperation = 'destination-over';

        if (this.currentBgMode === 'blur') {
            ctx.filter = 'blur(15px) brightness(1.1)';
            ctx.drawImage(results.image, 0, 0, procCanvas.width, procCanvas.height);
            ctx.filter = 'none';
        } else if (this.currentBgMode === 'color') {
            ctx.fillStyle = this.currentBgValue;
            ctx.fillRect(0, 0, procCanvas.width, procCanvas.height);
        } else if (this.currentBgMode === 'image') {
            if (this.bgImageObj.complete) {
                ctx.drawImage(this.bgImageObj, 0, 0, procCanvas.width, procCanvas.height);
            } else {
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, procCanvas.width, procCanvas.height);
            }
        }
        ctx.restore();
    }

    async processBg() {
        if (!this.cameraStream) return;
        this.initSelfieSegmentation();

        const videoElem = document.createElement('video');
        videoElem.srcObject = this.cameraStream;
        await videoElem.play();

        this.procCanvas.width = videoElem.videoWidth || 1280;
        this.procCanvas.height = videoElem.videoHeight || 720;

        const self = this;
        const sendToMediaPipe = async () => {
            if (self.currentBgMode === 'none') return;
            await self.selfieSegmentation.send({ image: videoElem });
            requestAnimationFrame(sendToMediaPipe);
        };
        sendToMediaPipe();
    }

    async applyBgFilter(type, value) {
        if (type === 'none') {
            this.currentBgMode = 'none';
            this.activeStreamType = 'camera';
            return this.cameraStream;
        }

        this.currentBgMode = type;
        this.currentBgValue = value;
        if (type === 'image') this.bgImageObj.src = value;

        await this.processBg();

        if (this.activeStreamType !== 'canvas') {
            this.activeStreamType = 'canvas';
            this.processedStream = this.procCanvas.captureStream(30);
        }
        return this.processedStream;
    }

    async startScreenShare() {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        return this.screenStream;
    }

    stopScreenShare() {
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(t => t.stop());
            this.screenStream = null;
        }
    }

    async replaceVideoTrack(newStream) {
        const localVideo = this.app.uiManager.localVideo;
        localVideo.srcObject = newStream;
        localVideo.style.transform = (this.activeStreamType === 'screen' ? 'none' : 'scaleX(-1)');

        const newTrack = newStream.getVideoTracks()[0];
        const peerConnections = this.app.peerManager.peerConnections;
        for (const peerId in peerConnections) {
            const pc = peerConnections[peerId];
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(newTrack);
        }
    }

    stopAll() {
        if (this.cameraStream) this.cameraStream.getTracks().forEach(t => t.stop());
        if (this.screenStream) this.screenStream.getTracks().forEach(t => t.stop());
        if (this.processedStream) this.processedStream.getTracks().forEach(t => t.stop());
    }
}

window.WebRTCMediaManager = WebRTCMediaManager;
