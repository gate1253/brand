const API_BASE = 'https://api.gate1253.workers.dev';

// DOM 요소 참조
const msg = document.getElementById('msg');
const searchBox = document.querySelector('.search-box');
const aliasInputContainer = document.getElementById('alias-input-container');
const expirationInputContainer = document.getElementById('expiration-input-container');
const customCodeNote = document.getElementById('custom-code-note');

// ── 렌더: 입력 폼 ──
function renderForm() {
	searchBox.innerHTML = `
		<input id="url-input" type="url" placeholder="원본 URL을 입력하세요 (예: https://example.com)" aria-label="원본 URL" />
		<button id="shorten-btn" type="button" class="btn primary">CREATE</button>
	`;
	msg.textContent = '';
	document.getElementById('shorten-btn').addEventListener('click', handleShorten);
	document.getElementById('url-input').focus();

	const user = window.user || (window.getCurrentUser ? window.getCurrentUser() : null);
	const isR1Active = document.getElementById('r1-btn')?.classList.contains('active');

	if (user) {
		if (isR1Active) {
			expirationInputContainer.classList.remove('hidden');
			aliasInputContainer.classList.add('hidden');
		} else {
			aliasInputContainer.classList.remove('hidden');
			expirationInputContainer.classList.add('hidden');
		}
		customCodeNote.style.display = 'none';
	} else {
		aliasInputContainer.classList.add('hidden');
		expirationInputContainer.classList.add('hidden');
		customCodeNote.style.display = 'block';
	}
}

// ── 렌더: 결과 표시 ──
function renderResult(shortUrl) {
	aliasInputContainer.classList.add('hidden');
	expirationInputContainer.classList.add('hidden');
	customCodeNote.classList.add('hidden');

	searchBox.innerHTML = `
		<div class="result-left">
			<a href="${shortUrl}" target="_blank" rel="noopener noreferrer" id="result-link">${shortUrl}</a>
		</div>
		<div class="result-actions">
			<button id="copy-btn" class="btn primary" type="button">COPY</button>
			<button id="qr-code-btn" class="btn primary" type="button">QR</button>
			<button id="create-new" class="btn primary" type="button">CREATE</button>
		</div>
	`;

	document.getElementById('copy-btn').addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(shortUrl);
			msg.textContent = '단축 URL이 클립보드에 복사되었습니다.';
		} catch (e) {
			msg.textContent = '복사 실패: 브라우저가 클립보드를 지원하지 않음';
		}
	});

	document.getElementById('qr-code-btn').addEventListener('click', () => {
		showQrCodeModal(shortUrl);
	});

	document.getElementById('create-new').addEventListener('click', () => {
		renderForm();
	});
}

// ── QR 코드 모달 ──
function showQrCodeModal(url) {
	const existingModal = document.getElementById('qr-modal-overlay');
	if (existingModal) existingModal.remove();

	const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(url)}`;

	const modalOverlay = document.createElement('div');
	modalOverlay.id = 'qr-modal-overlay';
	modalOverlay.classList.add('modal-overlay');

	modalOverlay.innerHTML = `
		<div class="modal-content">
			<button class="modal-close-btn">&times;</button>
			<h2>QR 코드</h2>
			<p>아래 QR 코드를 스캔하여 단축 URL에 접속하세요.</p>
			<img id="qr-code-image" src="${qrCodeUrl}" alt="QR Code for ${url}" class="qr-code-image">
			<div class="qr-code-url">${url}</div>
			<button id="download-qr-btn" class="btn primary small" type="button">QR 코드 다운로드</button>
		</div>
	`;

	document.body.appendChild(modalOverlay);

	modalOverlay.querySelector('.modal-close-btn').addEventListener('click', () => {
		modalOverlay.remove();
	});

	document.getElementById('download-qr-btn').addEventListener('click', () => {
		const link = document.createElement('a');
		link.href = qrCodeUrl;
		link.download = 'qrcode_' + new URL(url).hostname.replace(/\./g, '_') + '.png';
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	});

	modalOverlay.addEventListener('click', (e) => {
		if (e.target === modalOverlay) modalOverlay.remove();
	});
}

// ── 단축 URL 생성 핸들러 ──
async function handleShorten() {
	const urlInput = document.getElementById('url-input');
	const url = urlInput.value.trim();
	if (!url) { msg.textContent = 'URL을 입력하세요.'; return; }
	msg.textContent = '요청 중...';

	const user = window.user || (window.getCurrentUser ? window.getCurrentUser() : null);

	const serviceButtons = document.querySelectorAll('.service-toggle-btn');
	let serviceType = 'r3';
	for (const btn of serviceButtons) {
		if (btn.classList.contains('active')) {
			serviceType = btn.id.replace('-btn', '');
			break;
		}
	}

	let requestBody = { url, type: serviceType };

	if (user) {
		if (serviceType === 'r1') {
			const expirationInput = document.getElementById('expiration-input');
			if (!expirationInput || !expirationInput.value) {
				msg.textContent = '만료일을 선택하세요.';
				return;
			}
			const utcCheckbox = document.getElementById('utc-checkbox');
			const localDate = new Date(expirationInput.value);
			if (utcCheckbox && utcCheckbox.checked) {
				requestBody.expiresAt = new Date(localDate.getTime() - (localDate.getTimezoneOffset() * 60000)).toISOString();
			} else {
				requestBody.expiresAt = localDate.toISOString();
			}
		} else {
			const aliasInput = document.getElementById('alias-input');
			if (aliasInput) {
				const alias = aliasInput.value.trim();
				if (alias) requestBody.alias = alias;
			}
		}
	}

	const headers = { 'Content-Type': 'application/json' };
	if (user && user.apiKey) {
		headers['Authorization'] = `Bearer ${user.apiKey}`;
	}

	try {
		const res = await fetch(`${API_BASE}/api/shorten`, {
			method: 'POST',
			headers: headers,
			body: JSON.stringify(requestBody)
		});
		const data = await res.json();
		if (!res.ok) {
			msg.textContent = data.error || '생성 실패';
			return;
		}
		renderResult(data.shortUrl);
		msg.textContent = '';
	} catch (e) {
		msg.textContent = '요청 중 오류';
		console.error(e);
	}
}

// ── 로그인 상태에 따른 UI 업데이트 ──
function updateUIForUser(user) {
	const authContainer = document.getElementById('auth-container');
	const r1Btn = document.getElementById('r1-btn');
	const r2Btn = document.getElementById('r2-btn');
	const r5Btn = document.getElementById('r5-btn');

	if (user) {
		r1Btn.classList.remove('hidden');
		r2Btn.classList.remove('hidden');
		r5Btn.classList.remove('hidden');
		const userName = user.name || 'User profile';
		authContainer.innerHTML = `
			${user.picture ? `<img src="${user.picture}" alt="${userName}" class="profile-picture clickable" id="profile-picture">` : ''}
			<button id="logout-btn" class="auth-button" type="button">Logout</button>
		`;
		document.getElementById('logout-btn').addEventListener('click', () => {
			window.logout();
		});

		if (r1Btn.classList.contains('active')) {
			expirationInputContainer.classList.remove('hidden');
			aliasInputContainer.classList.add('hidden');
		} else {
			aliasInputContainer.classList.remove('hidden');
			expirationInputContainer.classList.add('hidden');
		}
		updateInfoBtnVisibility();
		customCodeNote.style.display = 'none';

		const profilePicture = document.getElementById('profile-picture');
		if (profilePicture) {
			profilePicture.addEventListener('click', () => {
				const apiKeyModal = document.getElementById('api-key-modal');
				const displayApiKey = document.getElementById('display-api-key');
				const displayUniqueUserId = document.getElementById('display-unique-user-id');
				const modalMessage = document.getElementById('modal-message');

				displayApiKey.textContent = user.apiKey;
				displayUniqueUserId.textContent = user.uniqueUserId;
				modalMessage.textContent = '';
				apiKeyModal.classList.remove('hidden');
			});
		}
	} else {
		authContainer.innerHTML = `<a class="auth-button" href="/member/login.html">Login</a>`;
		aliasInputContainer.classList.add('hidden');
		expirationInputContainer.classList.add('hidden');
		updateInfoBtnVisibility();
		customCodeNote.style.display = 'block';
	}
}

// ── Info 버튼 가시성 ──
function updateInfoBtnVisibility() {
	const user = window.user || window.getCurrentUser();
	const infoBtn = document.getElementById('info-btn');
	const r1Btn = document.getElementById('r1-btn');
	const r2Btn = document.getElementById('r2-btn');

	if (user && infoBtn && r1Btn && r2Btn && (r1Btn.classList.contains('active') || r2Btn.classList.contains('active'))) {
		infoBtn.classList.remove('hidden');
	} else if (infoBtn) {
		infoBtn.classList.add('hidden');
	}
}

// ── DOMContentLoaded: 초기화 ──
document.addEventListener('DOMContentLoaded', () => {
	const r1Btn = document.getElementById('r1-btn');
	const r2Btn = document.getElementById('r2-btn');
	const r3Btn = document.getElementById('r3-btn');
	const r5Btn = document.getElementById('r5-btn');
	const logoImg = document.getElementById('logo-img');
	const leadText = document.getElementById('lead-text');
	const urlParams = new URLSearchParams(window.location.search);
	let user;

	if (urlParams.get('testuser') === '1') {
		user = {
			name: 'Test User',
			picture: 'https://lh3.googleusercontent.com/a/default-user=s96-c',
			apiKey: 'test-api-key-for-viewing-123',
			uniqueUserId: 'test-user-id-for-viewing-456'
		};
	} else {
		user = window.getCurrentUser();
	}

	window.user = user;
	updateUIForUser(user);

	// 모달 닫기
	document.getElementById('modal-close-btn').addEventListener('click', () => {
		document.getElementById('api-key-modal').classList.add('hidden');
	});

	// API 키 복사
	document.getElementById('copy-api-key-btn').addEventListener('click', async () => {
		const apiKey = document.getElementById('display-api-key').textContent;
		const modalMessage = document.getElementById('modal-message');
		try {
			await navigator.clipboard.writeText(apiKey);
			modalMessage.textContent = 'API 키가 클립보드에 복사되었습니다.';
		} catch (err) {
			modalMessage.textContent = 'API 키 복사 실패.';
		}
	});

	// 사용자 ID 복사
	document.getElementById('copy-user-id-btn').addEventListener('click', async () => {
		const uniqueUserId = document.getElementById('display-unique-user-id').textContent;
		const modalMessage = document.getElementById('modal-message');
		try {
			await navigator.clipboard.writeText(uniqueUserId);
			modalMessage.textContent = '고유 사용자 ID가 클립보드에 복사되었습니다.';
		} catch (err) {
			modalMessage.textContent = '고유 사용자 ID 복사 실패.';
		}
	});

	// ── 서비스 모드 전환 ──
	const setMode = (mode) => {
		[r1Btn, r2Btn, r3Btn, r5Btn].forEach(btn => btn.classList.remove('active'));
		document.getElementById(`${mode.toLowerCase()}-btn`).classList.add('active');

		if (mode === 'R1') {
			logoImg.src = 'assets/images/logo-r1.jpg';
			logoImg.alt = 'R1';
			leadText.textContent = '간단하고 빠른 One Time URL 생성 서비스';
			if (user) { expirationInputContainer.classList.remove('hidden'); aliasInputContainer.classList.add('hidden'); }
		} else if (mode === 'R2') {
			logoImg.src = 'assets/images/logo-r2.jpg';
			logoImg.alt = 'R2';
			leadText.textContent = '원본 URL 노출을 막아주는 안전한 단축 URL 서비스';
			if (user) { aliasInputContainer.classList.remove('hidden'); expirationInputContainer.classList.add('hidden'); }
		} else if (mode === 'R3') {
			logoImg.src = 'assets/images/logo-r3.jpg';
			logoImg.alt = 'R3';
			leadText.textContent = '간단하고 빠른 단축 URL 생성 서비스';
			if (user) { aliasInputContainer.classList.remove('hidden'); expirationInputContainer.classList.add('hidden'); }
		} else if (mode === 'R5') {
			logoImg.src = 'assets/images/logo-r5.jpg';
			logoImg.alt = 'R5';
			leadText.textContent = '대용량 파일 서비스에 적합한 단축 URL 생성 서비스';
			if (user) { aliasInputContainer.classList.remove('hidden'); expirationInputContainer.classList.add('hidden'); }
		}
		updateInfoBtnVisibility();
	};

	r1Btn.addEventListener('click', (e) => { e.preventDefault(); setMode('R1'); });
	r2Btn.addEventListener('click', (e) => { e.preventDefault(); setMode('R2'); });
	r3Btn.addEventListener('click', (e) => { e.preventDefault(); setMode('R3'); });
	r5Btn.addEventListener('click', (e) => { e.preventDefault(); setMode('R5'); });

	// ── Intro 비디오 모달 ──
	const introLink = document.querySelector('.top-right-intro');
	const videoModal = document.getElementById('video-modal');
	const closeVideoModal = document.getElementById('close-video-modal');
	const videoContainer = document.getElementById('video-container');

	function openIntroVideo() {
		const videoUrl = introLink.getAttribute('href');
		videoContainer.innerHTML = `<video style="display:block;width:100%;height:100%;" controls autoplay playsinline muted><source src="${videoUrl}" type="video/mp4"></video>`;
		videoModal.classList.remove('hidden');
	}

	function closeIntroVideo() {
		videoModal.classList.add('hidden');
		videoContainer.innerHTML = '';
	}

	introLink.addEventListener('click', (e) => { e.preventDefault(); openIntroVideo(); });
	if (!localStorage.getItem('hasSeenIntro')) { openIntroVideo(); localStorage.setItem('hasSeenIntro', 'true'); }
	closeVideoModal.addEventListener('click', closeIntroVideo);
	videoModal.addEventListener('click', (e) => { if (e.target === videoModal) closeIntroVideo(); });

	// ESC 키로 모달 닫기
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			if (!videoModal.classList.contains('hidden')) closeIntroVideo();
			const infoModal = document.getElementById('info-modal');
			if (!infoModal.classList.contains('hidden')) infoModal.classList.add('hidden');
			const apiKeyModal = document.getElementById('api-key-modal');
			if (!apiKeyModal.classList.contains('hidden')) apiKeyModal.classList.add('hidden');
		}
	});

	// ── 만료일 입력 필드 ──
	const expirationInput = document.getElementById('expiration-input');
	expirationInput.addEventListener('focus', function () { this.type = 'datetime-local'; this.placeholder = ''; });
	expirationInput.addEventListener('blur', function () { if (!this.value) { this.type = 'text'; this.placeholder = '만료일'; } });

	// ── Info 모달 ──
	const infoBtn = document.getElementById('info-btn');
	const infoModal = document.getElementById('info-modal');
	const infoModalCloseBtn = document.getElementById('info-modal-close-btn');
	const infoModalTitle = document.getElementById('info-modal-title');
	const infoModalBody = document.getElementById('info-modal-body');

	infoBtn.addEventListener('click', () => {
		if (r1Btn.classList.contains('active')) {
			infoModalTitle.textContent = "R1 Service Description";
			infoModalBody.innerHTML = `
				<table class="info-table">
					<tr><th>항목</th><th>설명</th></tr>
					<tr><td><strong>404 대체 이미지</strong></td><td><code>404={http image address}</code></td></tr>
					<tr><td colspan="2" class="hint">* 만료 후에는 해당 이미지로 대체 됩니다.</td></tr>
				</table>`;
		} else if (r2Btn.classList.contains('active')) {
			infoModalTitle.textContent = "R2 Service Description";
			infoModalBody.innerHTML = `
				<table class="info-table">
					<tr><th>항목</th><th>파라미터 (Query String)</th><th>서버 주소</th></tr>
					<tr><td><strong>채팅</strong></td><td><code>with=websocket&type=html</code></td><td>wss://chat.gate1253.kro.kr</td></tr>
					<tr><td><strong>화상채팅</strong></td><td><code>with=webrtc&type=html</code></td><td>wss://chat.gate1253.kro.kr 또는 <br>https://webrtc.gate1253.workers.dev</td></tr>
					<tr><td><strong>플레이어</strong></td><td><code>with=player&type=html</code></td><td>'{MP4|M3U8}' 파일 주소</td></tr>
					<tr><td><strong>쿼리스트링</strong></td><td><code>with=querystring&type=forward</code></td><td>호출 시 쿼리스트링을 원본으로 전달</td></tr>
				</table>`;
		}
		infoModal.classList.remove('hidden');
	});

	infoModalCloseBtn.addEventListener('click', () => infoModal.classList.add('hidden'));
	infoModal.addEventListener('click', (e) => { if (e.target === infoModal) infoModal.classList.add('hidden'); });
});

// ── 초기 렌더 ──
renderForm();
