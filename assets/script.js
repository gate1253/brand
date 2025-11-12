document.addEventListener('DOMContentLoaded', () => {
    const introButton = document.getElementById('intro-button');
    const modal = document.getElementById('video-modal');
    const closeButton = document.querySelector('.close-button');
    const videoContainer = document.getElementById('video-container');

    function openModal() {
        const videoUrl = introButton.dataset.videoUrl;
        if (videoUrl) {
            videoContainer.innerHTML = `<video src="${videoUrl}" controls autoplay playsinline></video>`;
            modal.classList.remove('hidden');
        }
    }

    function closeModal() {
        modal.classList.add('hidden');
        videoContainer.innerHTML = ''; // 비디오 엘리먼트를 제거하여 재생 중지
    }

    introButton.addEventListener('click', openModal);
    closeButton.addEventListener('click', closeModal);

    // 모달 오버레이 클릭 시 닫기
    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            closeModal();
        }
    });

    // ESC 키로 모달 닫기
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
            closeModal();
        }
    });
});
