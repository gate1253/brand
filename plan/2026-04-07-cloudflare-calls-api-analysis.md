# Cloudflare Calls API - 공식 구현 분석 및 적용 (2026-04-07)

## 분석 소스

- **Cloudflare Orange (Meet)**: `github.com/cloudflare/orange`
- **Cloudflare PartyTracks**: `github.com/cloudflare/partykit/packages/partytracks`
- 핵심 파일: `packages/partytracks/src/client/PartyTracks.ts`

---

## 1. Cloudflare Calls API 타입 정의 (callsTypes.ts)

```typescript
// /tracks/new 응답
interface TracksResponse {
    sessionDescription: SessionDescription;
    requiresImmediateRenegotiation: boolean;  // ★ 핵심 플래그
    tracks?: TrackObject[];
}

// /renegotiate 응답 — SDP 없음, 에러만 반환
interface RenegotiationResponse {
    errorCode?: string;
    errorDescription?: string;
}
```

**핵심 발견**: `/renegotiate` 응답에는 SDP가 포함되지 않는다.

---

## 2. Push 흐름 (로컬 트랙 → SFU)

```
1. peerConnection.createOffer()
2. peerConnection.setLocalDescription(offer)
3. POST /sessions/{id}/tracks/new
   Body: { sessionDescription: { type: "offer", sdp }, tracks: [{ trackName, mid, location: "local" }] }
4. 응답: { sessionDescription: { type: "answer", sdp }, tracks: [...] }
5. peerConnection.setRemoteDescription(answer)
6. await signalingStateIsStable()  ★ 반드시 stable 대기
```

- Push는 항상 클라이언트 offer를 포함
- 서버는 answer를 반환
- SDP 교환 완료 후 signaling state stable 대기 필수

---

## 3. Pull 흐름 (원격 트랙 구독) ★ 가장 중요

```
1. POST /sessions/{id}/tracks/new
   Body: { tracks: [{ location: "remote", sessionId, trackName }] }
   ★ sessionDescription 포함하지 않음!

2. 응답: { sessionDescription, requiresImmediateRenegotiation, tracks }

3. 트랙 mid 매핑 (trackName + sessionId로 매칭)

4. if (requiresImmediateRenegotiation) {    ★ 이 플래그가 true일 때만!
       peerConnection.setRemoteDescription(offer)
       peerConnection.createAnswer()
       peerConnection.setLocalDescription(answer)
       PUT /sessions/{id}/renegotiate
         Body: { sessionDescription: { type: "answer", sdp: currentLocalDescription.sdp } }
       await signalingStateIsStable()
   }
```

---

## 4. Close 흐름 (트랙 제거) ★ 406 해결의 핵심

```
1. transceiver.stop()
2. peerConnection.createOffer()
3. peerConnection.setLocalDescription(offer)
4. PUT /sessions/{id}/tracks/close
   Body: { tracks: [{ mid }], sessionDescription: { type: "offer", sdp }, force: false }
5. 응답: { sessionDescription: { type: "answer", sdp } }
6. peerConnection.setRemoteDescription(answer)
```

- Close도 Push와 같이 클라이언트 offer를 포함
- **`/renegotiate`가 아닌 `/tracks/close` 전용 엔드포인트 사용**

---

## 5. 추가 패턴

### signalingStateIsStable()
- Push, Pull, Close 모든 SDP 교환 후 호출
- signalingState가 "stable"이 될 때까지 대기 (5초 타임아웃)

### FIFOScheduler (Task Queue)
- 모든 API 호출(push, pull, close)을 직렬화
- 우리 코드의 `_enqueue()` + `_taskQueue`와 동일한 패턴

### BulkRequestDispatcher
- 같은 이벤트 루프 틱에서 발생하는 여러 push/pull 요청을 하나의 벌크 요청으로 병합
- `setTimeout(0)`으로 매크로태스크에서 발송
- 우리 코드에는 없는 최적화 (향후 적용 가능)

---

## 6. 406 에러 근본 원인 및 해결

### 근본 원인

화면 공유 시작 시 `renegotiate()`가 **2번 호출**됨:
1. 화면 공유 시작 → `renegotiate()` → screen push via `/tracks/new` → 성공
2. `onended` 이벤트 또는 기타 트리거 → 화면 공유 종료 → `stopScreenTransceiver()` + `renegotiate()`
3. 2번째 renegotiate: `newTracks: 0` → offer를 `/renegotiate`에 전송

서버 응답:
```json
{"errorCode":"invalid_params","errorDescription":"sessionDescription.type=answer is expected"}
```

**서버는 이미 pending offer를 가지고 있어서 answer를 기대하는데, 클라이언트는 offer를 보냄 → 406**

### 해결

기존 코드는 트랙 종료 시 `stopScreenTransceiver()` + `renegotiate()`를 사용했으나,
Cloudflare partytracks 패턴에 맞춰 `/tracks/close` 엔드포인트를 도입:

| 변경 | 내용 |
|---|---|
| **webrtc-worker.js** | `/tracks/close` 프록시 엔드포인트 추가, CORS에 PUT 메서드 추가 |
| **WebRTCManager.js** | `closeScreenTrack()` 메서드 추가 — `transceiver.stop()` + offer로 `/tracks/close` 호출 |
| **UIManager.js** | 화면 공유 종료: `stopScreenTransceiver()` + `renegotiate()` → `closeScreenTrack()` 교체 |

### 추가 안전장치

- `renegotiate()` 시작 시 `signalingState !== 'stable'`이면 rollback 후 진행
- `/renegotiate` 실패 시 throw 대신 return (task queue 보호)
- `_extractSdp()` 헬퍼로 `{ sessionDescription }` 및 `{ sdp, type }` 두 응답 형식 모두 처리

---

## 7. 기존 문제점 비교표

| 항목 | 기존 코드 | Cloudflare 공식 | 현재 코드 |
|---|---|---|---|
| renegotiate 조건 | `type === 'offer'`이면 항상 | `requiresImmediateRenegotiation` | `requiresImmediateRenegotiation` ✅ |
| 트랙 종료 | `stopScreenTransceiver` + `/renegotiate` offer | `/tracks/close` + offer | `/tracks/close` + offer ✅ |
| /renegotiate 응답 | SDP 처리 시도 | 에러만 확인 | 에러만 확인 ✅ |
| 상태 보호 | 없음 | `signalingStateIsStable()` | rollback 보호 ✅ |

---

## 8. 커밋 이력

| 커밋 | 내용 | 결과 |
|---|---|---|
| `41dd514` | 화면 공유 시 수신자 버튼 숨김 | ✅ |
| `70dbdb1` | pull에 SDP offer 포함 시도 | ❌ have-local-offer glare |
| `456329f` | SDP 포함 revert + 응답 처리 추가 | ❌ 406 지속 |
| `9fd2014` | 406 시 fresh offer retry | ❌ 406 지속 |
| `a75fc5b` | `requiresImmediateRenegotiation` 플래그 적용 | ❌ signalingState 타임아웃 |
| `80e1827` | `_extractSdp` 헬퍼 + stable wait 제거 | ❌ 406 지속 |
| `ddde596` | 상세 디버그 로깅 추가 | 🔍 원인 파악 |
| `2f9f6e8` | rollback 보호 + 406 throw 방지 | 🔍 "answer expected" 확인 |
| `5d8774f` | **`/tracks/close` 도입 + `closeScreenTrack()`** | ✅ 해결 |
| `676ce77` | webrtc proxy에 `/tracks/close` 엔드포인트 추가 | ✅ |
| `c94d262` | CORS에 PUT 메서드 추가 | ✅ |
| `d6bae22` | 디버그 로깅 제거 (v1.1.0) | ✅ |

---

## 9. 버전 표시

- `res200/workers/templates/sfuTemplate.js` 헤더에 버전 표시 추가
- 현재 버전: `v1.1.0` (stable)
