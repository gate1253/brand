# Screen Share - Bug Fixes & Feature (2026-04-06)

## 1. 반복 화면 공유 실패 (송신 측)

### 문제
- 화면 공유를 최초 1회 성공 후 해제 → 재공유 시 영상 스트림이 정상 전달되지 않음

### 원인
- `stopScreenTransceiver()`에서 트랜시버를 `inactive`로 설정하고 `_inactive` 플래그로 재사용을 시도
- Cloudflare Calls SFU는 한번 비활성화된 트랜시버의 `inactive → sendonly` 전환을 안정적으로 처리하지 못함
- 재사용 시 `replaceTrack()`을 await 없이 호출하여 `getTrackName(null)` → `'video'` 반환 가능성

### 수정 (WebRTCManager.js, UIManager.js)
- `stopScreenTransceiver()`: `_inactive` 플래그 대신 `transceiversMap`에서 매핑 완전 삭제
- `UIManager` 화면 공유 시작: 비활성 트랜시버 재사용 로직 제거, 항상 `pc.addTransceiver()`로 새 트랜시버 생성

---

## 2. 수신 측 화면 공유 미표시 (재공유 시)

### 문제
- 수신 클라이언트에서 첫 번째 화면 공유만 표시되고, 해제 후 재공유 시 영상이 나타나지 않음

### 원인 (2가지)

#### 원인 A: 원격 트랙 영구 종료
- `removeRemoteTrackUI()`에서 `track.stop()` 호출 → `readyState`가 `ended`로 영구 전환
- SFU가 같은 트랜시버를 재활용해도 `receiver.track`이 이미 종료 상태라 미디어 수신 불가
- 추가로 `transceiver.direction = 'inactive'` 강제 설정이 SFU 재활용과 불일치 유발

#### 원인 B: `pc.ontrack` 미발생
- SFU가 기존 트랜시버를 재활성화할 때 브라우저는 `RTCRtpReceiver`가 이미 존재하므로 `pc.ontrack`을 다시 발생시키지 않음
- 코드가 `ontrack` 이벤트에만 의존하여 UI 설정 → 두 번째부터 UI 미생성

### 수정 (UIManager.js, WebRTCManager.js)

#### removeRemoteTrackUI 수정
- `track.stop()` 호출 제거 (원격 트랙은 stop하면 안 됨)
- `transceiver.direction = 'inactive'` 제거 (SFU가 관리)
- `stream.removeTrack()` + `transceiversMap.delete()`만 수행

#### _ensurePulledTracksDisplayed 추가
- pull 완료 후 `ontrack` 발생 여부와 무관하게 `transceiver.receiver.track`을 직접 확인
- 매핑된 트랙의 UI가 없으면 `setupRemoteVideo()` 호출
- `_processPendingTracksInner()`의 3개 SRD+answer 코드 경로 모두에 적용

---

## 3. 동시 화면 공유 차단 (신규 기능)

### 문제
- 이미 화면 공유 중인 상태에서 상대방이 화면 공유를 시작하면 스트림이 깨짐

### 구현

#### WebRTCManager.js
- `_remoteScreenSharerSid` 필드: 현재 화면 공유 중인 원격 참가자 세션 ID 추적
- `handleRemoteTracksUpdate()`: `tracks-update` 메시지에서 `screen` 트랙 유무 감지 → 잠금 상태 갱신
- `handleRemoteLeave()`: 화면 공유 중인 참가자 퇴장 시 잠금 해제
- `isRemoteScreenSharing()`: 원격 화면 공유 활성 여부 확인

#### UIManager.js
- `toggleScreenBtn.onclick`: 버튼 클릭 시 원격 화면 공유 중이면 차단 + 토스트 표시
- `updateScreenShareLock()`: 버튼 `disabled` 상태 및 CSS `disabled` 클래스 토글
- `_showScreenShareBlockedToast()`: "Someone is already sharing their screen" 토스트 2.5초 표시

### 동작 흐름
1. A가 화면 공유 시작 → `tracks-update`에 `screen` 포함 → B의 `_remoteScreenSharerSid = A`
2. B가 화면 공유 버튼 클릭 → `isRemoteScreenSharing() === true` → 차단 + 토스트
3. A가 화면 공유 중단 → `tracks-update`에서 `screen` 사라짐 → B의 버튼 활성화
4. A가 퇴장 → `handleRemoteLeave()` → B의 버튼 활성화

---

## 4. renegotiate() 트랙 중복 push로 인한 SFU 매핑 오염

### 문제
- 화면 공유 최초 1회는 정상이나, 해제 후 재공유 시 스트림 전송 안 됨
- 수신자에 화면 공유 UI 컨테이너는 생성되지만, 내부 스트림은 비어 있음
- 송신자 배경 변경 시 수신자의 화면 공유 컨테이너에도 송신자 얼굴이 표시됨 (얼굴 두 군데)

### 원인
- `renegotiate()`가 매번 **모든** sendonly 트랜시버(audio, video, screen)를 `/tracks/new`에 전송
- Cloudflare Calls `/tracks/new` API는 **새 트랙 등록** 전용이므로, 이미 등록된 audio/video를 재전송하면 SFU가 중복 트랙 배포를 생성
- 중복으로 인해:
  - 수신자에 video 트랙이 screen 컨테이너에도 배포됨 → 배경 변경 시 얼굴이 두 곳에 표시
  - 새 screen 트랙이 올바르게 매핑되지 않음 → 화면 공유 컨테이너에 스트림 없음
- SFU 응답의 `data.tracks`가 `location: t.location || 'remote'`로 처리되어, local 트랙 매핑이 `'remote'`로 덮어씌워짐 → `transceiversMap` 오염

### 수정 (WebRTCManager.js)

#### `_pushedMids` Set 추가
- 이미 SFU에 push 완료된 트랜시버 mid를 추적
- 새 트랜시버만 `/tracks/new` 요청에 포함

#### `renegotiate()` 분기 처리
- **새 트랙 존재 시**: `/tracks/new`에 **새 트랙만** 전송 (기존 audio/video 제외)
- **새 트랙 없음 (SDP 변경만)**: `/renegotiate`로 SDP offer만 전송 (화면 공유 해제 등)
- push 성공 후 `_pushedMids`에 mid 추가

#### SFU 응답 처리 보호
- `data.tracks` 처리 시 `_pushedMids`에 포함된 mid는 건너뛰어 local 매핑 보호
- SFU 응답이 local 트랙을 'remote'로 덮어쓰는 문제 방지

#### `stopScreenTransceiver()` 정리
- `_pushedMids`에서 해당 mid 삭제 → 재공유 시 새 트랙으로 인식

### 동작 흐름 (수정 후)
1. 초기 접속: audio+video push → `_pushedMids = {mid0, mid1}`
2. 1차 화면 공유: screen만 push (mid2) → `_pushedMids = {mid0, mid1, mid2}`
3. 공유 해제: `_pushedMids`에서 mid2 삭제, `/renegotiate`로 SDP만 전송
4. 2차 화면 공유: 새 screen만 push (mid3) → `_pushedMids = {mid0, mid1, mid3}`
5. 수신자: screen 트랙만 새로 구독, audio/video 중복 배포 없음

---

## 수정된 파일
- `public/js/sfu/WebRTCManager.js`
- `public/js/sfu/UIManager.js`

## 커밋
- `dd63c56` - fix(sfu): fix repeated screen share failure and add single-share lock
- `f7beb23` - fix(sfu): fix receiver not displaying re-shared screen stream
- (미커밋) - fix(sfu): prevent duplicate track push by sending only new tracks to SFU
