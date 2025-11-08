const urlInput = document.getElementById('url-input');
const shortenBtn = document.getElementById('shorten-btn');
const msg = document.getElementById('msg');
const API_BASE = 'https://res302.gate1253.workers.dev';

shortenBtn.addEventListener('click', async () => {
	const url = urlInput.value.trim();
	// alias는 비회원이 제공하지 않으므로 전송하지 않음
	if(!url){ msg.textContent = 'URL을 입력하세요.'; return; }
	msg.textContent = '요청 중...';
	try{
		const res = await fetch(`${API_BASE}/api/shorten`, {
			method: 'POST',
			headers: {'Content-Type':'application/json'},
			body: JSON.stringify({url})
		});
		const data = await res.json();
		if(!res.ok){
			msg.textContent = data.error || '생성 실패';
			return;
		}
		msg.innerHTML = `단축 URL 생성: <a href="${data.shortUrl}" target="_blank" rel="noopener noreferrer">${data.shortUrl}</a>`;
		urlInput.value = '';
	}catch(e){
		msg.textContent = '요청 중 오류';
		console.error(e);
	}
});
