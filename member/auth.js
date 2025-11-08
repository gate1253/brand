// Simple PKCE + Google OAuth client flow (browser)
// IMPORTANT: replace CLIENT_ID with your Google OAuth Client ID
(function(){
  // 구성: 반드시 실제 값으로 교체
  const CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID_HERE';
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

    // token exchange
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.code_verifier
    });

    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {'Content-Type':'application/x-www-form-urlencoded'},
      body: body.toString()
    });
    if(!res.ok) {
      const txt = await res.text();
      throw new Error('token_exchange_failed: ' + txt);
    }
    const tokens = await res.json(); // access_token, id_token, refresh_token (maybe)
    // decode id_token payload (basic)
    const idp = tokens.id_token && tokens.id_token.split('.');
    let profile = {};
    if(idp && idp[1]){
      try{
        const payload = JSON.parse(atob(idp[1].replace(/-/g,'+').replace(/_/g,'/')));
        profile = payload;
      }catch(e){}
    }
    // persist tokens/profile (short-lived)
    localStorage.setItem('res302_tokens', JSON.stringify({tokens, profile, ts: Date.now()}));
    // cleanup pkce
    localStorage.removeItem('res302_pkce');
    // optionally redirect to member area or return profile
    return profile;
  };

  // helper to get current user
  window.getCurrentUser = function(){
    try{
      const s = JSON.parse(localStorage.getItem('res302_tokens') || '{}');
      return s.profile || null;
    }catch(e){ return null; }
  };

})();
