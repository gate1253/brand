# RES302 (Gate1253)

간단한 단축 URL 서비스 RES302입니다. Cloudflare Pages(정적) + Cloudflare Workers(KV)를 사용합니다.

## 파일 구조
- `index.html`: 서비스 메인 페이지 (Google 메인 페이지와 유사한 UI)
- `assets/style.css`, `assets/app.js`: UI/클라이언트 로직 (동적 폼, 결과 표시, API 호출)
- `assets/images/logo.png`: 서비스 로고 이미지
- `workers/res302-worker.js`: 단축 URL API, 리다이렉트 Worker, Google OAuth 백엔드 처리
- `member/`: 회원 관련 페이지 및 스크립트
  - `member/login.html`: Google 로그인 페이지
  - `member/signup.html`: Google 회원가입 페이지
  - `member/callback.html`: Google OAuth 콜백 처리 페이지
  - `member/auth.js`: 클라이언트 측 Google OAuth (PKCE) 흐름 처리 및 API 키 관리
- `support/index.html`: API 사용 예제 및 지원 페이지

## 요구사항(Cloudflare 설정)
1.  Cloudflare Pages로 `d:\workspace\gate1253\brand` 폴더를 배포 (정적 사이트).
2.  Cloudflare Workers 생성 후 아래 스크립트 업로드.
3.  **KV 네임스페이스 생성 및 바인딩**:
    *   `RES302_KV`: 단축 URL 데이터 저장
    *   `USER_KV`: 사용자 프로필 및 API 키 정보 저장 (키 형식: `user:<uniqueUserId>`)
    *   `API_KEY_TO_SUB_KV`: API 키와 `uniqueUserId` 매핑 저장
    *   `GOOGLE_SUB_TO_USER_ID_KV`: Google `sub` ID와 `uniqueUserId` 매핑 저장
4.  **Worker 환경 변수(Secrets) 설정**:
    *   `GOOGLE_CLIENT_ID`: Google Cloud Console에서 생성한 OAuth 클라이언트 ID (웹 애플리케이션 타입)
    *   `GOOGLE_SECRET`: Google Cloud Console에서 생성한 OAuth 클라이언트 보안 비밀
5.  **Worker 라우트 설정**:
    *   도메인 전체를 Worker로 처리하거나 (예: `your-domain.com/*`), 최소한 다음 경로에 매핑:
        *   `your-domain.com/api/*`
        *   `your-domain.com/member/*`
        *   `your-domain.com/support/*`
        *   `your-domain.com/*` (리다이렉트 및 정적 파일 서빙)

## API 명세
Base: `https://api.gate1253.workers.dev` (배포 도메인으로 교체)

### 1) `POST /api/shorten`
-   **설명**: 단축 URL 생성 또는 업데이트
-   **요청**:
    -   `Content-Type: application/json`
    -   **헤더**:
        -   `Authorization: Bearer <YOUR_API_KEY>` (커스텀 코드 사용 시 필수)
    -   **Body**:
        ```json
        {
          "url": "https://example.com/long/path",
          "alias": "mycustomcode" // 선택 사항. 로그인 사용자만 사용 가능.
        }
        ```
-   **응답 (성공)**:
    -   **커스텀 코드 사용 시 (200 또는 201)**:
        ```json
        {
          "ok": true,
          "code": "YOUR_UNIQUE_USER_ID/mycustomcode",
          "shortUrl": "https://api.gate1253.workers.dev/YOUR_UNIQUE_USER_ID/mycustomcode",
          "message": "단축 URL이 생성되었습니다." // 또는 "URL이 업데이트되었습니다."
        }
        ```
    -   **무작위 코드 사용 시 (201)**:
        ```json
        {
          "ok": true,
          "code": "abc123",
          "shortUrl": "https://api.gate1253.workers.dev/abc123",
          "message": "단축 URL이 생성되었습니다."
        }
        ```
-   **오류 예**:
    -   `400`: `url` 필요, 필수 파라미터 누락
    -   `401`: 인증되지 않았거나 유효하지 않은 API 키
    -   `403`: API 키와 사용자 ID 불일치 (내부 검증 오류)
    -   `500`: 서버 오류

### 2) `POST /api/member`
-   **설명**: Google OAuth 콜백 처리 및 토큰 교환. 클라이언트(`auth.js`)에서 인증 코드를 받아 워커가 Google과 통신하여 토큰을 교환하고 사용자 프로필 및 API 키를 생성/조회합니다.
-   **요청**:
    -   `Content-Type: application/json`
    -   **Body**:
        ```json
        {
          "code": "...",           // Google로부터 받은 인증 코드
          "code_verifier": "...",  // PKCE 코드 검증자
          "redirect_uri": "..."    // Google OAuth 리디렉션 URI
        }
        ```
-   **응답 (성공 200)**:
    ```json
    {
      "tokens": { /* Google OAuth 토큰 정보 */ },
      "profile": {
        "sub": "...",
        "name": "...",
        "email": "...",
        "picture": "...",
        "uniqueUserId": "YOUR_UNIQUE_USER_ID" // 12자리 고유 회원 ID
      },
      "apiKey": "YOUR_GENERATED_API_KEY", // 사용자에게 발급된 API 키
      "uniqueUserId": "YOUR_UNIQUE_USER_ID" // 12자리 고유 회원 ID
    }
    ```
-   **오류 예**:
    -   `400`: 필수 파라미터 누락, Google 토큰 교환 실패
    -   `500`: 서버 오류, OAuth 환경 변수 미설정

### 3) `GET /api/list`
-   **설명**: 등록된 단축 URL 목록 조회 (현재는 모든 URL을 반환)
-   **응답 (200)**:
    ```json
    [
      {"code":"abc123","url":"https://example.com/...","createdAt":"2025-11-08T..."},
      {"code":"YOUR_UNIQUE_USER_ID/mycustomcode","url":"https://example.com/...","createdAt":"2025-11-08T...","updatedAt":"2025-11-09T..."},
      ...
    ]
    ```

### 4) `GET /{code}` 또는 `GET /{uniqueUserId}/{code}`
-   **설명**: 단축 URL 리다이렉트
-   **동작**: 302 리다이렉트 -> 원본 URL
-   **예**:
    -   `GET /abc123` -> `302 Location: https://example.com/...`
    -   `GET /YOUR_UNIQUE_USER_ID/mycustomcode` -> `302 Location: https://example.com/...`

## 배포 팁 (GitHub Actions + Wrangler)
GitHub Actions를 사용하여 Cloudflare Workers에 자동 배포합니다.

1.  **Cloudflare KV 네임스페이스 생성**:
    ```bash
    wrangler kv:namespace create "RES302_KV" --preview
    wrangler kv:namespace create "USER_KV" --preview
    wrangler kv:namespace create "API_KEY_TO_SUB_KV" --preview
    wrangler kv:namespace create "GOOGLE_SUB_TO_USER_ID_KV" --preview
    ```
    (각 명령 실행 후 출력되는 `id` 값을 기록해 둡니다.)

2.  **GitHub 저장소 Secrets 설정**:
    GitHub 저장소 `Settings` > `Secrets and variables` > `Actions`로 이동하여 다음 Secrets를 추가합니다.
    *   `CF_API_TOKEN`: Cloudflare API 토큰 (Workers, Workers KV 권한 포함)
    *   `CF_ACCOUNT_ID`: Cloudflare 계정 ID
    *   `CF_KV_NAMESPACE_ID`: `RES302_KV`의 ID
    *   `CF_USER_KV_NAMESPACE_ID`: `USER_KV`의 ID
    *   `CF_API_KEY_TO_SUB_KV_NAMESPACE_ID`: `API_KEY_TO_SUB_KV`의 ID
    *   `CF_GOOGLE_SUB_TO_USER_ID_KV_NAMESPACE_ID`: `GOOGLE_SUB_TO_USER_ID_KV`의 ID
    *   `GOOGLE_CLIENT_ID`: Google Cloud Console에서 생성한 OAuth 클라이언트 ID (웹 애플리케이션 타입)
    *   `GOOGLE_SECRET`: Google Cloud Console에서 생성한 OAuth 클라이언트 보안 비밀

3.  **`wrangler.toml` 설정 (로컬 개발용)**:
    `d:\workspace\gate1253\brand\wrangler.toml` 파일에 실제 KV ID를 직접 입력하여 로컬에서 `wrangler dev` 등으로 테스트할 수 있습니다. (CI에서는 GitHub Secrets를 사용하여 동적으로 생성됩니다.)

4.  **Google Cloud Console OAuth 클라이언트 설정**:
    *   Google Cloud Console > API 및 서비스 > 사용자 인증 정보로 이동합니다.
    *   **OAuth 클라이언트 ID**를 생성하고, 애플리케이션 유형을 **"웹 애플리케이션"**으로 선택합니다.
    *   **"승인된 리디렉션 URI"**에 `https://{배포-도메인}/member/callback.html`을 정확히 추가합니다. (예: `https://api.gate1253.workers.dev/member/callback.html`)
    *   생성된 **클라이언트 ID**와 **클라이언트 보안 비밀**을 복사하여 GitHub Secrets에 `GOOGLE_CLIENT_ID`와 `GOOGLE_SECRET`으로 각각 등록합니다.

5.  **`auth.js` CLIENT_ID 업데이트**:
    `d:\workspace\gate1253\brand\member\auth.js` 파일의 `CLIENT_ID` 변수를 Google Cloud Console에서 생성한 **웹 애플리케이션 타입**의 클라이언트 ID로 교체합니다.

6.  **배포 트리거**:
    `main` 브랜치에 `workers/` 폴더 내의 변경 사항을 푸시하면 GitHub Actions 워크플로(`deploy.yml`)가 자동으로 실행되어 Cloudflare Workers에 배포됩니다.

## UI/UX 변경 사항
-   **메인 페이지**: Google 메인 페이지와 유사한 중앙 정렬 레이아웃으로 변경.
-   **로고**: `assets/images/logo.png`를 사용하여 크게 확대된 로고 표시.
-   **상단 버튼**: 우측 상단에 "Support" 링크와 동적으로 "Login" 또는 "Logout" 버튼 및 로그인된 사용자 프로필 사진 표시.
-   **커스텀 코드**: 로그인된 사용자에게만 커스텀 코드 입력 필드가 노출되며, API 키를 통해 인증 후 사용 가능.
-   **결과 표시**: 단축 URL 생성 후 입력 폼 자리에 결과 URL과 "복사", "새로 만들기" 버튼이 표시.

## 주의사항
-   KV는 eventual consistency가 있으므로 즉시 반영성에 제약이 있을 수 있습니다.
-   프로덕션에서는 입력 검증/보안(오픈 리다이렉트, 악성 URL 필터링 등)을 추가 권장합니다.
-   API 키는 민감한 정보이므로 클라이언트 측에서 안전하게 다루고, 서버 측에서 철저히 검증해야 합니다.
