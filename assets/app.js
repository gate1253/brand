const API_BASE = 'https://api.gate1253.workers.dev';
// 메시지 영역
const msg = document.getElementById('msg');
// 검색 폼 컨테이너
const searchBox = document.querySelector('.search-box');
// 추가: 커스텀 코드 입력 필드 컨테이너 및 안내 메시지
const aliasInputContainer = document.getElementById('alias-input-container');
// R1용 만료일 컨테이너
const expirationInputContainer = document.getElementById('expiration-input-container');
const customCodeNote = document.getElementById('custom-code-note');

// 렌더: 입력 폼 (input + 단축 버튼)
function renderForm() {
	searchBox.innerHTML = `
		<input id="url-input" type="url" placeholder="원본 URL을 입력하세요 (예: https://example.com)" aria-label="원본 URL" />
		<button id="shorten-btn" type="button" class="btn primary">CREATE</button>
	`;
	msg.textContent = '';
	document.getElementById('shorten-btn').addEventListener('click', handleShorten);
	document.getElementById('url-input').focus();

	// 추가: "새로 만들기" 시 로그인 상태를 다시 확인하여 커스텀 코드 입력창을 복원합니다.
	// 테스트용 window.user가 있으면 그것을 사용하고, 없으면 실제 로그인 함수를 호출합니다.
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

// 렌더: 결과 (링크는 왼쪽, 버튼들은 오른쪽에 동일한 위치/스타일)
function renderResult(shortUrl){
	// 추가: 결과 표시 시 커스텀 코드 입력 필드와 안내 메시지 숨김
	aliasInputContainer.classList.add('hidden');
	expirationInputContainer.classList.add('hidden');
	customCodeNote.classList.add('hidden');

	searchBox.innerHTML = `
		<div class="result-left" style="flex:1;min-width:0">
			<a href="${shortUrl}" target="_blank" rel="noopener noreferrer" id="result-link" style="font-weight:600;color:#1a73e8;word-break:break-all;">${shortUrl}</a>
		</div>
		<div class="result-actions" style="display:flex;gap:8px;align-items:center">
			<button id="copy-btn" class="btn primary" type="button">COPY</button>
			<button id="qr-code-btn" class="btn primary" type="button">QR</button>
			<button id="create-new" class="btn primary" type="button">CREATE</button>
		</div>
	`;
	// 복사 동작
	document.getElementById('copy-btn').addEventListener('click', async () => {
		try{
			await navigator.clipboard.writeText(shortUrl);
			msg.textContent = '단축 URL이 클립보드에 복사되었습니다.';
		}catch(e){
			msg.textContent = '복사 실패: 브라우저가 클립보드를 지원하지 않음';
		}
	});
	// QR Code 버튼 동작
	document.getElementById('qr-code-btn').addEventListener('click', () => {
		showQrCodeModal(shortUrl); // 새로운 QR 코드 모달 함수 호출
	});
	// 새로 만들기: 폼 복원
	document.getElementById('create-new').addEventListener('click', () => {
		renderForm();
	});
}

// 추가: QR 코드 모달 표시 함수
function showQrCodeModal(url) {
    // 기존 모달이 있다면 제거
    const existingModal = document.getElementById('qr-modal-overlay');
    if (existingModal) {
        existingModal.remove();
    }

    // QR 코드 이미지 URL 생성 (외부 API 사용)
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(url)}`;

    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'qr-modal-overlay';
    modalOverlay.classList.add('modal-overlay'); // style.css의 .modal-overlay 스타일 활용

    modalOverlay.innerHTML = `
        <div class="modal-content">
            <button class="modal-close-btn">&times;</button>
            <h2>QR 코드</h2>
            <p>아래 QR 코드를 스캔하여 단축 URL에 접속하세요.</p>
            <img id="qr-code-image" src="${qrCodeUrl}" alt="QR Code for ${url}" style="width:150px; height:150px; margin: 20px auto 10px auto; display: block; border: 1px solid #eee; padding: 5px; background: white;">
            <div style="font-size: 14px; color: #555; word-break: break-all; margin-top: 10px; margin-bottom: 20px;">${url}</div>
            <button id="download-qr-btn" class="btn primary small" type="button">QR 코드 다운로드</button>
        </div>
    `;

    document.body.appendChild(modalOverlay);

    // 모달 닫기 이벤트 리스너
    modalOverlay.querySelector('.modal-close-btn').addEventListener('click', () => {
        modalOverlay.remove();
    });

    // 다운로드 버튼 이벤트 리스너
    document.getElementById('download-qr-btn').addEventListener('click', () => {
        const link = document.createElement('a');
        link.href = qrCodeUrl;
        link.download = 'qrcode_' + new URL(url).hostname.replace(/\./g, '_') + '.png'; // 파일명 설정
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });

    // 오버레이 클릭 시 모달 닫기
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) {
            modalOverlay.remove();
        }
    });
}

// 단축 생성 핸들러
async function handleShorten(){
	const urlInput = document.getElementById('url-input');
	const url = urlInput.value.trim();
	if(!url){ msg.textContent = 'URL을 입력하세요.'; return; }
	msg.textContent = '요청 중...';

	let alias = null;
	// 테스트용 window.user가 있으면 그것을 사용하고, 없으면 실제 로그인 함수를 호출합니다.
	const user = window.user || (window.getCurrentUser ? window.getCurrentUser() : null);
	
	// 활성화된 서비스 타입을 찾아서 요청 본문에 추가합니다.
	const serviceButtons = document.querySelectorAll('.service-toggle-btn');
	let serviceType = 'r3'; // 기본값
	for (const btn of serviceButtons) {
		if (btn.classList.contains('active')) {
			serviceType = btn.id.replace('-btn', ''); // 'r1-btn' -> 'r1'
			break;
		}
	}

	let requestBody = { url, type: serviceType }; // 기본 요청 본문
	
	if (user) {
		if (serviceType === 'r1') {
			const expirationInput = document.getElementById('expiration-input');
			if (!expirationInput || !expirationInput.value) {
				msg.textContent = '만료일을 선택하세요.';
				return;
			}

			const utcCheckbox = document.getElementById('utc-checkbox');
			requestBody.expiresAt = expirationInput.value;
			if (utcCheckbox) {
				requestBody.isUtc = utcCheckbox.checked;
			}

		} else {
			const aliasInput = document.getElementById('alias-input');
			if (aliasInput) {
				alias = aliasInput.value.trim();
				if (alias) {
					requestBody.alias = alias;
				}
			}
		}
	}

	const headers = {'Content-Type':'application/json'};
	if (user && user.apiKey) {
		headers['Authorization'] = `Bearer ${user.apiKey}`;
	}

	try{
		const res = await fetch(`${API_BASE}/api/shorten`, {
			method: 'POST',
			headers: headers,
			body: JSON.stringify(requestBody) // 수정된 requestBody 사용
		});
		const data = await res.json();
		if(!res.ok){
			msg.textContent = data.error || '생성 실패';
			return;
		}
		// 성공: 결과로 대체 (버튼들은 오른쪽, 단축 생성 버튼과 동일한 스타일/위치)
		renderResult(data.shortUrl);

		// 완료 후 '요청 중...' 메시지 제거
		msg.textContent = '';
	}catch(e){
		msg.textContent = '요청 중 오류';
		console.error(e);
	}
}

// 초기 렌더
renderForm();
