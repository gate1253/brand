# RES302 (Gate1253)

간단한 단축 URL 서비스 RES302입니다. Cloudflare Pages(정적) + Cloudflare Workers(KV)를 사용합니다.

## 파일 구조
- index.html : 서비스 메인
- assets/style.css, assets/app.js : UI/클라이언트 로직
- workers/res302-worker.js : 단축 URL API 및 리다이렉트 Worker

## 요구사항(Cloudflare 설정)
1. Cloudflare Pages로 `d:\workspace\gate1253\brand` 폴더를 배포 (정적 사이트).
2. Cloudflare Workers 생성 후 아래 스크립트 업로드.
3. Workers에 KV 네임스페이스 생성 후 바인딩 이름을 `RES302_KV`로 설정.
4. Worker 라우트를 설정:
   - 도메인 전체를 Worker로 처리하거나 (예: example.com/*), 최소한 API/리다이렉트 경로에 매핑.

## API 명세
Base: https://your-domain.example

1) POST /api/shorten
- 설명: 단축 URL 생성
- 요청
  - Content-Type: application/json
  - Body:
    {
      "url": "https://example.com/long/path",
      "alias": "custom" // 선택
    }
- 응답 (성공 201)
  {
    "ok": true,
    "code": "abc123",
    "shortUrl": "https://your-domain.example/abc123"
  }
- 오류 예:
  - 400: url 필요
  - 409: alias 중복
  - 500: 서버 오류

2) GET /api/list
- 설명: 등록된 단축 URL 목록 조회
- 응답 (200)
  [
    {"code":"abc123","url":"https://example.com/...","createdAt":"2025-11-08T..."},
    ...
  ]

3) GET /{code}
- 설명: 단축 URL 리다이렉트
- 동작: 302 리다이렉트 -> 원본 URL
- 예: GET /abc123 -> 302 Location: https://example.com/...

## 배포 팁 (Wrangler 사용 예)
1. KV 네임스페이스 생성
   wrangler kv:namespace create "RES302_KV" --preview
2. wrangler.toml에 바인딩 추가
   [vars] 등이 아닌 bindings 예시:
   [[kv_namespaces]]
   binding = "RES302_KV"
   id = "<생성된 namespace id>"
3. Worker 배포
   wrangler publish workers/res302-worker.js --name res302-worker
4. Pages는 brand 폴더로 배포 (Cloudflare Pages 설정에서 빌드 없이 업로드 가능)

## 주의사항
- KV는 eventual consistency가 있으므로 즉시 반영성에 제약이 있을 수 있음.
- 프로덕션에서는 입력 검증/보안(오픈 리다이렉트, 악성 URL 필터링 등)을 추가 권장.
