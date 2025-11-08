const CODE_KEY = 'RES302_codes_list_v1'; // KV에 저장되는 메타 리스트 키
//API 
function makeCode(len=6){
	const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let s='';
	for(let i=0;i<len;i++) s+=chars[Math.floor(Math.random()*chars.length)];
	return s;
}

// 추가: API 키 생성 함수 (더 긴 길이)
function makeApiKey(len = 32) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let key = '';
    for (let i = 0; i < len; i++) {
        key += chars[Math.floor(Math.random() * chars.length)];
    }
    return key;
}

// 변경: CORS 유틸 추가
function corsHeaders() {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		'Access-Control-Max-Age': '86400'
	};
}
function jsonResponse(obj, status = 200, extraHeaders = {}) {
	const headers = Object.assign({}, corsHeaders(), {'Content-Type':'application/json'}, extraHeaders);
	return new Response(JSON.stringify(obj), {status, headers});
}

// 추가: API 키 검증 함수
async function validateApiKey(request, env) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null; // API 키 없음
    }
    const apiKey = authHeader.slice(7); // "Bearer " 제거

    // API_KEY_TO_SUB_KV에서 API 키로 사용자 sub를 찾음
    const userSub = await env.API_KEY_TO_SUB_KV.get(apiKey);
    if (!userSub) {
        return null; // 유효하지 않은 API 키
    }

    // USER_KV에서 사용자 데이터 검증 (선택 사항이지만 보안 강화)
    const userData = await env.USER_KV.get(`user:${userSub}`, { type: 'json' });
    if (!userData || userData.apiKey !== apiKey) {
        return null; // 사용자 데이터 불일치 또는 키 무효화
    }
    return userData; // 유효한 사용자 데이터 반환
}


async function handleShorten(req, env){
	try{
		const body = await req.json();
		let {url, alias} = body;
		if(!url) return jsonResponse({error:'url 필요'}, 400);
		// 간단한 url 보정
		if(!/^https?:\/\//i.test(url)) url = 'https://' + url;
		
		let code = alias ? alias.trim() : null;
		let operationType = 'create'; // 'create' 또는 'update'

		// alias가 제공된 경우 API 키 검증 필수
		if(code){
			const user = await validateApiKey(req, env);
			if (!user) {
				return jsonResponse({error: '인증되지 않았거나 유효하지 않은 API 키입니다.'}, 401);
			}
			// alias가 유효한 사용자에게만 허용되도록 추가 검증 가능 (예: alias가 사용자의 소유인지)
			// 현재는 단순히 API 키만 검증하고 alias 사용을 허용
			
			const existingUrl = await env.RES302_KV.get(code);
			if(existingUrl){
				// alias가 이미 존재하면 업데이트 작업
				operationType = 'update';
				// URL이 동일하면 불필요한 쓰기 방지
				if (existingUrl === url) {
					const shortUrl = `${new URL(req.url).origin}/${code}`;
					return jsonResponse({ok:true, code, shortUrl, message: 'URL이 이미 존재하며 변경사항이 없습니다.'}, 200);
				}
			} else {
				// alias가 제공되었지만 존재하지 않음. 새 커스텀 alias 생성.
				// 이 경우 충돌 검사는 필요 없음 (사용자가 명시적으로 지정했고, 현재 유일함).
			}
		}else{
			// alias가 제공되지 않음, 무작위 코드 생성 (API 키 없이도 가능)
			for(let i=0;i<6;i++){
				const c = makeCode();
				if(!(await env.RES302_KV.get(c))){
					code = c; break;
				}
			}
			if(!code) code = makeCode(8); // 6번 시도 후에도 코드 생성 실패 시 대체
		}
		
		// KV에 URL 저장/업데이트
		await env.RES302_KV.put(code, url);

		// 메타 리스트(CODE_KEY) 업데이트
		const raw = await env.RES302_KV.get(CODE_KEY);
		let list = raw ? JSON.parse(raw) : [];

		if (operationType === 'update') {
			const index = list.findIndex(item => item.code === code);
			if (index !== -1) {
				list[index].url = url;
				list[index].updatedAt = new Date().toISOString(); // 업데이트 시간 추가
			} else {
				// 이 경우는 발생하지 않아야 하지만, 리스트가 동기화되지 않은 경우를 대비해 추가
				list.push({code, url, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()});
			}
		} else { // operationType === 'create'
			list.push({code, url, createdAt: new Date().toISOString()});
		}

		await env.RES302_KV.put(CODE_KEY, JSON.stringify(list));
		
		const shortUrl = `${new URL(req.url).origin}/${code}`;
		const status = operationType === 'update' ? 200 : 201;
		const message = operationType === 'update' ? 'URL이 업데이트되었습니다.' : '단축 URL이 생성되었습니다.';
		return jsonResponse({ok:true, code, shortUrl, message}, status);
	}catch(e){
		console.error('handleShorten error:', e); // 오류 로깅 추가
		return jsonResponse({error:'서버 오류'}, 500);
	}
}

async function handleList(env){
	const raw = await env.RES302_KV.get(CODE_KEY);
	const list = raw ? JSON.parse(raw) : [];
	return jsonResponse(list, 200);
}

// 추가: Google OAuth 콜백을 처리하고 토큰을 교환하는 함수
async function handleAuthCallback(request, env) {
	try {
		const { code, code_verifier, redirect_uri } = await request.json();
		if (!code || !code_verifier || !redirect_uri) {
			return jsonResponse({ error: '필수 파라미터가 누락되었습니다.' }, 400);
		}

		// 환경 변수에서 Google OAuth 클라이언트 정보 가져오기
		const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
		const GOOGLE_SECRET = env.GOOGLE_SECRET;

		if (!GOOGLE_CLIENT_ID || !GOOGLE_SECRET) {
			return jsonResponse({ error: '서버에 OAuth 환경 변수가 설정되지 않았습니다.' }, 500);
		}

		const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			code: code,
			client_id: GOOGLE_CLIENT_ID,
			client_secret: GOOGLE_SECRET,
			redirect_uri: redirect_uri,
			code_verifier: code_verifier,
		});

		const res = await fetch(TOKEN_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
		});

		if (!res.ok) {
			const errorText = await res.text();
			console.error('Google Token Exchange Error:', errorText);
			return jsonResponse({ error: 'Google 인증 토큰 교환에 실패했습니다.', details: errorText }, 400);
		}

		const tokens = await res.json();
		let profile = {};

		// id_token에서 프로필 정보 디코딩
		if (tokens.id_token) {
			const idp = tokens.id_token.split('.');
			if (idp[1]) {
				try {
					const payload = JSON.parse(atob(idp[1].replace(/-/g, '+').replace(/_/g, '/')));
					profile = {
						sub: payload.sub, // Google 고유 사용자 ID
						name: payload.name,
						email: payload.email,
						picture: payload.picture,
					};
				} catch (e) {
					console.error('ID Token decoding failed:', e);
				}
			}
		}

		// 추가: 사용자 정보 및 API 키 관리
		if (!profile.sub) {
			return jsonResponse({ error: 'Google 프로필 ID(sub)를 가져올 수 없습니다.' }, 500);
		}

		const userKey = `user:${profile.sub}`;
		let userData = await env.USER_KV.get(userKey, { type: 'json' });
		let apiKey;

		if (userData) {
			// 기존 사용자: API 키 재사용 및 마지막 로그인 시간 업데이트
			apiKey = userData.apiKey;
			userData.lastLoginAt = new Date().toISOString();
		} else {
			// 새 사용자: API 키 생성 및 사용자 정보 저장
			apiKey = makeApiKey(); // 새 API 키 생성
			userData = {
				sub: profile.sub,
				email: profile.email,
				name: profile.name,
				picture: profile.picture,
				apiKey: apiKey,
				createdAt: new Date().toISOString(),
				lastLoginAt: new Date().toISOString(),
			};
		}
		await env.USER_KV.put(userKey, JSON.stringify(userData));
		// 추가: API 키 -> sub 매핑 저장
		await env.API_KEY_TO_SUB_KV.put(apiKey, profile.sub);


		// 클라이언트에 토큰, 프로필 정보, API 키 반환
		return jsonResponse({ tokens, profile, apiKey }, 200);

	} catch (e) {
		console.error('Auth Callback Error:', e);
		return jsonResponse({ error: '인증 처리 중 서버 오류가 발생했습니다.' }, 500);
	}
}


export async function handleRequest(request, env){
	// OPTIONS preflight 처리 추가
	if(request.method === 'OPTIONS'){
		return new Response(null, {status:204, headers: corsHeaders()});
	}

	const url = new URL(request.url);
	const pathname = url.pathname;

	// 추가: POST /api/member 라우트
	if (request.method === 'POST' && pathname === '/api/member') {
		return handleAuthCallback(request, env);
	}

	// API: POST /api/shorten
	if(request.method === 'POST' && pathname === '/api/shorten'){
		return handleShorten(request, env);
	}
	// API: GET /api/list
	if(request.method === 'GET' && pathname === '/api/list'){
		return handleList(env);
	}
	// 리다이렉트: GET /{code}
	if(request.method === 'GET' && pathname.length > 1){
		const code = pathname.slice(1).split('/')[0];
		const target = await env.RES302_KV.get(code);
		if(target){
			// redirect 시에도 CORS 헤더 포함
			return new Response(null, {status:302, headers: Object.assign({Location: target}, corsHeaders())});
		}
		return new Response('Not found', {status:404, headers: corsHeaders()});
	}
	// 기타
	return new Response('Not found', {status:404, headers: corsHeaders()});
}

export default {
	fetch: handleRequest
};
