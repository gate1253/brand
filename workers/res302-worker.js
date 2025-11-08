const CODE_KEY = 'RES302_codes_list_v1'; // KV에 저장되는 메타 리스트 키
//API
function makeCode(len=6){
	const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let s='';
	for(let i=0;i<len;i++) s+=chars[Math.floor(Math.random()*chars.length)];
	return s;
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

async function handleShorten(req, env){
	try{
		const body = await req.json();
		let {url, alias} = body;
		if(!url) return jsonResponse({error:'url 필요'}, 400);
		// 간단한 url 보정
		if(!/^https?:\/\//i.test(url)) url = 'https://' + url;
		let code = alias ? alias.trim() : null;
		if(code){
			const exists = await env.RES302_KV.get(code);
			if(exists) return jsonResponse({error:'alias 중복'}, 409);
		}else{
			// 충돌 방지 루프
			for(let i=0;i<6;i++){
				const c = makeCode();
				if(!(await env.RES302_KV.get(c))){
					code = c; break;
				}
			}
			if(!code) code = makeCode(8);
		}
		const item = {code, url, createdAt: new Date().toISOString()};
		await env.RES302_KV.put(code, url);
		// update list
		const raw = await env.RES302_KV.get(CODE_KEY);
		const list = raw ? JSON.parse(raw) : [];
		list.push(item);
		await env.RES302_KV.put(CODE_KEY, JSON.stringify(list));
		const shortUrl = `${new URL(req.url).origin}/${code}`;
		return jsonResponse({ok:true, code, shortUrl}, 201);
	}catch(e){
		return jsonResponse({error:'서버 오류'}, 500);
	}
}

async function handleList(env){
	const raw = await env.RES302_KV.get(CODE_KEY);
	const list = raw ? JSON.parse(raw) : [];
	return jsonResponse(list, 200);
}

export async function handleRequest(request, env){
	// OPTIONS preflight 처리 추가
	if(request.method === 'OPTIONS'){
		return new Response(null, {status:204, headers: corsHeaders()});
	}

	const url = new URL(request.url);
	const pathname = url.pathname;
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
