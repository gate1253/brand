const CODE_KEY = 'RES302_codes_list_v1'; // KV에 저장되는 메타 리스트 키

function makeCode(len=6){
	const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let s='';
	for(let i=0;i<len;i++) s+=chars[Math.floor(Math.random()*chars.length)];
	return s;
}

async function handleShorten(req, env){
	try{
		const body = await req.json();
		let {url, alias} = body;
		if(!url) return new Response(JSON.stringify({error:'url 필요'}), {status:400, headers:{'Content-Type':'application/json'}});
		// 간단한 url 보정
		if(!/^https?:\/\//i.test(url)) url = 'https://' + url;
		let code = alias ? alias.trim() : null;
		if(code){
			const exists = await env.RES302_KV.get(code);
			if(exists) return new Response(JSON.stringify({error:'alias 중복'}), {status:409, headers:{'Content-Type':'application/json'}});
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
		return new Response(JSON.stringify({ok:true, code, shortUrl}), {status:201, headers:{'Content-Type':'application/json'}});
	}catch(e){
		return new Response(JSON.stringify({error:'서버 오류'}), {status:500, headers:{'Content-Type':'application/json'}});
	}
}

async function handleList(env){
	const raw = await env.RES302_KV.get(CODE_KEY);
	const list = raw ? JSON.parse(raw) : [];
	return new Response(JSON.stringify(list), {status:200, headers:{'Content-Type':'application/json'}});
}

export async function handleRequest(request, env){
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
			return Response.redirect(target, 302);
		}
		return new Response('Not found', {status:404});
	}
	// 기타
	return new Response('Not found', {status:404});
}

export default {
	fetch: handleRequest
};
