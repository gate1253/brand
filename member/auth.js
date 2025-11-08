// Simple PKCE + Google OAuth client flow (browser)
// IMPORTANT: replace CLIENT_ID with your Google OAuth Client ID
(function(){
  // 구성: 반드시 실제 값으로 교체
  const CLIENT_ID = '178229425055-plib60kregok453r7rr3oti5aug7b14m.apps.googleusercontent.com';
  const REDIRECT_URI = (location.origin + '/member/callback.html');
  const SCOPE = 'openid email profile';
  const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
  const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

  // util: base64url
  function base64urlEncode(arrayBuffer){
    const bytes = new Uint8Array(arrayBuffer);
    let str = '';
    for (let i=0;i<bytes.byteLength;i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }

  async function sha256(plain){
    const encoder = new TextEncoder();
    const data = encoder.encode(plain);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return base64urlEncode(hash);
  }

  function randString(len=64){
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(n => ('0'+(n%36).toString(36)).slice(-1)).join('').slice(0,len);
  }

  // start auth: generate code_verifier -> code_challenge -> redirect
  window.startAuth = async function(action){
    if(!CLIENT_ID || CLIENT_ID.includes('YOUR_GOOGLE')) {
      alert('Google CLIENT_ID를 auth.js에 설정하세요.');
      return;
    }
    const code_verifier = randString(64);
    const code_challenge = await sha256(code_verifier);
    // persist verifier (short-lived)
    localStorage.setItem('res302_pkce', JSON.stringify({code_verifier, ts: Date.now(), action}));
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPE,
      code_challenge: code_challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account'
    });
    location.href = AUTH_ENDPOINT + '?' + params.toString();
  };

  // exchange code for tokens and return profile
  window.handleCallback = async function(){
    const url = new URL(location.href);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if(error) throw new Error('auth_error:' + error);
    if(!code) throw new Error('no_code');

    const pkce = JSON.parse(localStorage.getItem('res302_pkce') || '{}');
    if(!pkce || !pkce.code_verifier) throw new Error('no_pkce');

    // 변경: 코드를 Google에 직접 보내는 대신, 워커(백엔드)로 전송합니다.
    // 워커가 안전하게 토큰 교환을 처리합니다.
    const WORKER_AUTH_ENDPOINT = 'https://res302.gate1253.workers.dev/api/member';

    const res = await fetch(WORKER_AUTH_ENDPOINT, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        code: code,
        code_verifier: pkce.code_verifier,
        redirect_uri: REDIRECT_URI // Google에 토큰 요청 시 필요하므로 워커에 전달
      })
    });

    if(!res.ok) {
      const txt = await res.text();
      throw new Error('worker_auth_failed: ' + txt);
    }

    // 워커는 { tokens, profile, apiKey, uniqueUserId } 객체를 반환해야 합니다.
    const data = await res.json();
    const { tokens, profile, apiKey, uniqueUserId } = data; // apiKey를 여기서 한 번만 구조 분해 할당

    // tokens, profile, apiKey 모두 존재하는지 확인
    if (!tokens || !profile) {
      throw new Error('worker_invalid_response: ' + JSON.stringify(data));
    }

    // 변경: 워커로부터 받은 apiKey와 uniqueUserId도 함께 저장
    if (!apiKey || !uniqueUserId) {
        throw new Error('worker_invalid_response: API Key 또는 uniqueUserId가 누락되었습니다.');
    }

    // persist tokens/profile/apiKey/uniqueUserId (short-lived)
    localStorage.setItem('res302_tokens', JSON.stringify({tokens, profile, apiKey, uniqueUserId, ts: Date.now()}));
    // cleanup pkce
    localStorage.removeItem('res302_pkce');
    // optionally redirect to member area or return profile
    return profile; // 프로필만 반환해도 되지만, localStorage에는 모든 정보가 저장됨
  };

  // helper to get current user
  window.getCurrentUser = function(){
    try{
      const s = JSON.parse(localStorage.getItem('res302_tokens') || '{}');
      // 변경: 프로필과 함께 apiKey, uniqueUserId도 반환
      return s.profile ? { ...s.profile, apiKey: s.apiKey, uniqueUserId: s.uniqueUserId } : null;
    }catch(e){ return null; }
  };

  // 추가: 로그아웃 기능
  window.logout = function() {
    localStorage.removeItem('res302_tokens');
    localStorage.removeItem('res302_pkce'); // 혹시 모를 잔여 데이터 정리
    location.reload(); // UI를 업데이트하기 위해 페이지 새로고침
  };

})();
