const API_BASE = 'https://res302.gate1253.workers.dev';
// 메시지 영역
const msg = document.getElementById('msg');
// 검색 폼 컨테이너
const searchBox = document.querySelector('.search-box');
// 추가: 커스텀 코드 입력 필드 컨테이너 및 안내 메시지
const aliasInputContainer = document.getElementById('alias-input-container');
const customCodeNote = document.getElementById('custom-code-note');

// 렌더: 입력 폼 (input + 단축 버튼)
function renderForm() {
	searchBox.innerHTML = `
		<input id="url-input" type="url" placeholder="원본 URL을 입력하세요 (예: https://example.com/long/path)" aria-label="원본 URL" />
		<button id="shorten-btn" type="button" class="btn primary">단축 생성</button>
	`;
	msg.textContent = '';
	document.getElementById('shorten-btn').addEventListener('click', handleShorten);
	document.getElementById('url-input').focus();

	// 추가: 로그인 상태에 따라 커스텀 코드 입력 필드와 안내 메시지 표시/숨김
	const user = window.getCurrentUser();
	if (user) {
		aliasInputContainer.classList.remove('hidden');
		customCodeNote.classList.add('hidden'); // 로그인 시 안내 메시지 숨김
	} else {
		aliasInputContainer.classList.add('hidden');
		customCodeNote.classList.remove('hidden'); // 로그아웃 시 안내 메시지 표시
	}
}

// 렌더: 결과 (링크는 왼쪽, 버튼들은 오른쪽에 동일한 위치/스타일)
function renderResult(shortUrl){
	// 추가: 결과 표시 시 커스텀 코드 입력 필드와 안내 메시지 숨김
	aliasInputContainer.classList.add('hidden');
	customCodeNote.classList.add('hidden');

	searchBox.innerHTML = `
		<div class="result-left" style="flex:1;min-width:0">
			<a href="${shortUrl}" target="_blank" rel="noopener noreferrer" id="result-link" style="font-weight:600;color:#1a73e8;word-break:break-all;">${shortUrl}</a>
		</div>
		<div class="result-actions" style="display:flex;gap:8px;align-items:center">
			<button id="copy-btn" class="btn primary" type="button">복사</button>
			<button id="create-new" class="btn primary" type="button">새로 만들기</button>
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
	// 새로 만들기: 폼 복원
	document.getElementById('create-new').addEventListener('click', () => {
		renderForm();
	});
}

// 단축 생성 핸들러
async function handleShorten(){
	const urlInput = document.getElementById('url-input');
	const url = urlInput.value.trim();
	if(!url){ msg.textContent = 'URL을 입력하세요.'; return; }
	msg.textContent = '요청 중...';

	let alias = null;
	const user = window.getCurrentUser();
	let requestBody = { url }; // 기본 요청 본문

	if (user) {
		const aliasInput = document.getElementById('alias-input');
		if (aliasInput) {
			alias = aliasInput.value.trim();
			if (alias) {
				requestBody.alias = alias;
				requestBody.uniqueUserId = user.uniqueUserId; // uniqueUserId 추가
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
