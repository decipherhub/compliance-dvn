# `backend` ↔ `main` 차이

이 문서를 처음 읽는 사람을 위한 안내입니다. 마지막 확인: 2026-07-31.

## ⚠️ 먼저 알아야 할 것: 아직 커밋되지 않았습니다

```
backend  70ffd60
main     70ffd60   ← 같은 커밋
```

두 브랜치는 **완전히 동일한 커밋을 가리킵니다.** `git log main..backend`는 0건입니다.
아래에 설명하는 모든 변경은 작성자의 로컬 작업 트리에만 있고, 아직 커밋·푸시되지 않았습니다.

**즉, 지금 `git checkout backend`를 해도 아무것도 받을 수 없습니다.** 이 문서는 "무엇이 올
예정인가"의 설명서이고, 실제로 받으려면 작성자가 커밋·푸시한 뒤여야 합니다.

작업 트리 규모:

| 구분           | 수량                          |
| -------------- | ----------------------------- |
| 추적 파일 수정 | 49 files, +3841 / −658        |
| 신규 파일      | 64개 (그중 38개가 `indexer/`) |

---

## 한눈에

`main`은 LayerZero V2 커스텀 DVN 예제에 제재 목록 대조 정도가 붙은 상태입니다.
`backend`는 그것을 **리스크 엔진 + 외부 인덱서 + 온체인 감사 추적**으로 확장합니다.

| 영역          | main                            | backend                                                   |
| ------------- | ------------------------------- | --------------------------------------------------------- |
| 판정          | 제재 주소 목록 대조 → 통과/거부 | 라벨 가중치 점수 + 소스 신뢰도 천장 → **4단계 행동**      |
| 행동          | allow / block                   | allow / **delay** / **manual-review** / block             |
| 보류 해제     | —                               | 시계(delay) 또는 **owner의 온체인 `approvePacket`**       |
| 그래프 분석   | 없음                            | 신규 `indexer/` 패키지 (Postgres, 최대 3-hop 근접성)      |
| 감사 추적     | 없음                            | 온체인 `RiskVerdict` 이벤트 → 인덱서 → Postgres → Grafana |
| 컨트랙트 검증 | 없음                            | Sourcify v2 조회 → `unverified_contract` 라벨             |
| 관측          | Prometheus 메트릭               | + Grafana 대시보드 2개 (compose 프로파일)                 |
| 배포          | 로컬/예제                       | **base-sepolia + optimism-sepolia 배포·와이어링 완료**    |

프로세스는 세 개이고, 서로 코드를 공유하지 않습니다. **서명된 HTTP 피드와 온체인
이벤트로만** 연결됩니다.

```
    사용자 send ──▶ EndpointV2 ──▶ ComplianceDVN.assignJob ──▶ JobAssigned
                                        ▲                          │ 폴링(15s)
                  submitVerification ───┘                          ▼
                  recordVerdict / PacketApproved            ┌──────────────┐
                            ▲                              │ worker       │
                            └────────── 판정 ◀─────────────│ (호스트)     │
                                                           └──────┬───────┘
                                                 서명된 피드 ◀────┘ HTTP :9091
                                                           ┌──────────────┐
    ERC-20 Transfer, RiskVerdict ─── 폴링(15s) ───────────▶│ indexer + PG │
                                                           │ (Docker)     │
                                                           └──────────────┘
```

---

## 1. 컨트랙트 — ABI 파괴적 변경 (재배포 필수)

`contracts/ComplianceDVN.sol` (+83 −5). **`submitVerification`의 시그니처가 바뀌었습니다.**

```solidity
// main
function submitVerification(bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations)

// backend  ← 판정 결과가 검증 트랜잭션에 동승
function submitVerification(
    bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations,
    uint8 action, uint16 score, uint256 reasonMask, bytes32 evidenceHash
)
```

컨트랙트는 업그레이더블이 아니므로 **기존 배포 주소를 재사용할 수 없습니다.** `dvn:preflight`가
이 불일치를 감지해 알려줍니다.

**생성자도 바뀌었습니다** — `assignJob`이 send library로 게이트되면서 `_sendUln` 파라미터가
추가됐습니다 (`(_owner, _operator, _sendUln, _receiveUln, _fee)`). 게이트가 없으면 아무나
`assignJob`을 호출해 임의 payloadHash로 `JobAssigned`를 발생시킬 수 있고, worker는 그걸 "우리
일"로 믿고 남의 패킷을 심사·verify하며 operator 가스를 태우게 됩니다. 아래 §5의 기존 배포는
이 게이트 이전 버전이므로 **재배포가 필요합니다** (`dvn:preflight`가 `sendUln()` 부재를 감지).

신규 함수·이벤트:

| 항목                                                                      | 권한            | 용도                                                                                                          |
| ------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| `recordVerdict(payloadHash, action, score, reasonMask, evidenceHash)`     | `onlyOperator`  | 검증하지 **않은** 패킷의 판정을 감사 기록으로 남김. `allow`는 거부됨 (그건 `submitVerification`에 동승하므로) |
| `approvePacket(bytes32 payloadHash)`                                      | **`onlyOwner`** | manual-review로 보류된 패킷을 사람이 해제                                                                     |
| `event RiskVerdict(payloadHash, action, score, reasonMask, evidenceHash)` | —               | 감사 추적의 원천                                                                                              |
| `event PacketApproved(payloadHash, approver)`                             | —               | worker가 이걸 관측해 보류를 해제                                                                              |

`approvePacket`이 `onlyOwner`인 것이 설계의 핵심입니다 — **worker(operator 키)가 자기가 보류한
패킷을 스스로 풀 수 없습니다.** 두 키를 같게 쓰면 이 보호가 사라집니다.

`ACTION_*` 상수는 `allow=0, delay=1, manual-review=2, block=3`이고, `reasonMask`는 추가 전용
비트마스크입니다 (`worker/assess/verdict.ts`의 `REASON_BITS`가 정본).

### ⚠️ `MyOFT.mint`는 테스트넷 전용입니다

`contracts/MyOFT.sol`에 데모용 `mint(address,uint256)`을 추가했습니다. **접근 제어가 전혀
없습니다.** 누구나 무한히 발행할 수 있으므로 메인넷에 절대 이 상태로 올리면 안 됩니다.

---

## 2. 신규 패키지 `indexer/` — 35 파일, TS 3,339줄

Docker + PostgreSQL로 도는 별도 프로세스. worker와 코드를 공유하지 않는 이유는 신뢰
경계를 나누기 위해서입니다 — 인덱서의 결론은 **서명된 피드**로만 worker에 들어가고, worker는
서명자 allowlist와 버전 단조 증가(리플레이 방지)를 확인합니다.

하는 일:

1. 체인 스캔 → `RiskVerdict` / `PacketApproved`(감사)와 ERC-20 `Transfer`(그래프 엣지) 수집
2. reorg 처리 — 저장된 블록 해시가 노드와 다르면 `REORG_DEPTH`(32) 창을 통째로 롤백
3. Sourcify v2로 컨트랙트 검증 여부 조회. 응답을 못 받은 `unknown`과 미검증 `unverified`를
   구분하고 **라벨은 후자만** 만듭니다
4. **최대 3-hop 근접성** — 홉마다 라벨·가중치가 다릅니다: outbound `sanctions_1hop`(70) /
   `sanctions_2hop`(45) / `sanctions_3hop`(25), inbound 40/20/10, 믹서 60/35/20. 경로는 같은
   체인·블록 비내림차순·단순 경로만 인정하고 최단 거리만 라벨링합니다. 주체 본인의 첫 outbound
   엣지를 제외한 **모든 엣지는 `TOKEN_MINIMUMS` 이상**이어야 합니다 (dust로 임의 주소를
   오염시키거나, 한 다리 건너 스미어하는 걸 막기 위함)
5. 10분마다 피드 빌드 → 정수만 쓰는 canonical JSON + EIP-191 서명 → `:9091`로 서빙

깊이는 **3홉까지**입니다 (`GRAPH_DEPTH = 3`, 정책 v2). 3-hop 라벨은 단독으로는 어떤 행동도
일으키지 않고(25 < delay 임계 30) 다른 신호와 합산될 때만 작용합니다.

---

## 3. worker 확장 — 33 파일 수정, 14 파일 신규 (+2,959 −466)

`main`에도 worker는 있었습니다. 판정 부분이 통째로 교체되고 보류 큐가 새로 생겼습니다.

신규 모듈:

| 파일                           | 역할                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| `assess/policy.ts`             | **정책 정본.** 라벨 가중치, 임계값, 딜레이 타이밍, `POLICY_VERSION` |
| `assess/verdict.ts`            | 온체인 인코딩 — `ACTION_CODES`, `REASON_BITS`, `evidenceHash`       |
| `assess/sources.ts`            | 소스별 신뢰도 / `EnforcementLevel`                                  |
| `assess/providers/contract.ts` | `getCode`, EIP-1967 프록시 슬롯 검사                                |
| `assess/providers/token.ts`    | `token()`/`symbol()`/`decimals()` → 가짜 스테이블코인 판별          |
| `assess/ingest/feed.ts`        | 인덱서 피드 수신 — 서명 검증, 리플레이 방지                         |
| `assess/canonical.ts`          | 서명 대상 canonical JSON                                            |
| `chain/reader.ts`              | TTL 캐시 + 타임아웃이 붙은 체인 조회                                |

판정은 **두 개의 게이트**를 통과합니다:

- **점수** — 라벨 가중치 합(100 상한) → 임계값 **90 / 60 / 30** → block / manual-review / delay / allow
- **천장** — 소스 신뢰도로 clamp. `DIRECT_HIT_LABELS`(`sanctions`, `sanctioned_mixer`,
  `scam_token`, `operator_deny`)가 없으면 점수가 얼마든 **자동 차단까지 가지 못하고
  manual-review로 눌립니다.** "1홉 + 믹서 노출"은 강한 정황이지 확정이 아니라서, 추론만으로
  자금을 묶지 않겠다는 판단입니다

`delay`는 5분 후 재심사이고 8회를 넘으면 manual-review로 승격됩니다. manual-review는
**시계로 절대 풀리지 않고** owner의 `approvePacket`만이 해제합니다.

### 환경변수 이름 변경 (주의)

worker의 서명 키가 `PRIVATE_KEY` → **`OPERATOR_PRIVATE_KEY`** 로 바뀌었습니다. 루트 `.env`의
`PRIVATE_KEY`는 owner 키이므로, 루트 파일을 worker로 복사하면 worker가 owner 권한을 갖게
됩니다. 그래서 worker 서비스는 **환경에 `PRIVATE_KEY`나 `OWNER_PRIVATE_KEY`가 있으면 —
`OPERATOR_PRIVATE_KEY`가 함께 있어도 — 부팅을 거부하고 이유를 설명합니다.**

`OWNER_PRIVATE_KEY`는 배포 셸에만 두세요. owner 액션(승인·거절)은 데모 대시보드에서 MetaMask
서명으로 이루어지므로, 어떤 서비스 환경에도 owner 키가 들어갈 일이 없습니다.

---

## 4. 그 밖의 변경

- **`oapp.contract.ts`** (신규) — OApp 컨트랙트 이름을 한 곳에서 결정합니다.
  기존 `ToyOFT`의 delegate가 팀원 키(`0x69bd4d7e…210c`)라 `lz:oapp:wire`가
  `LZ_Unauthorized()`로 실패했습니다. 그래서 테스트용으로 `MyOFT`를 새로 배포해 쓰고 있고,
  되돌릴 때는 `OAPP_CONTRACT=ToyOFT` 하나만 바꾸면 됩니다
- **`tasks/preflight.ts`** (신규, `dvn:preflight`) — 트랜잭션을 보내기 전에 서명자·RPC·잔액
  (실측 배포 가스 × 25 여유)·operator 분리·기존 배포 ABI 호환성·**OApp delegate 권한**을
  검사합니다. 위 `LZ_Unauthorized`를 미리 잡아줍니다
- **`tasks/verifyWiring.ts`** (신규, `dvn:verify-wiring`) — 온체인 `UlnConfig`를 디코딩해
  우리 DVN이 send/receive 양쪽 `requiredDVNs`에 들어있는지 확인
- **`test/hardhat/ComplianceDVN.test.ts`** (신규, 13 tests) — `forge`가 설치돼 있지 않아
  실행 가능한 hardhat 테스트를 별도로 뒀습니다. foundry 테스트도 갱신했지만 미실행입니다
- **`layerzero.config.ts`** — DVN 주소가 비어 있으면 0 주소로 기본값을 쓰지 않고 **throw**
  합니다. 0 주소로 와이어링하면 조용히 성공한 뒤 해당 경로의 모든 메시지가 영구히 검증
  불가가 되기 때문입니다
- **루트 `package.json`** — 쓰이지 않던 `zod@4`를 제거했습니다. LayerZero의 `zod ^3.22.4`
  peer를 가로채 `lz:oapp:wire`가 `keyValidator._parse is not a function`으로 죽었습니다
- **`DEPLOYMENT.md`** (신규) — 배포 순서. 아래 Quickstart가 이 문서를 가리킵니다

---

## 5. 배포된 주소 (테스트넷, 와이어링 완료)

| 체인             | 컨트랙트      | 주소                                         |
| ---------------- | ------------- | -------------------------------------------- |
| base-sepolia     | ComplianceDVN | `0x99DC27868af093Ee699Fb0ac4c952F19b298F5E2` |
| optimism-sepolia | ComplianceDVN | `0x99DC27868af093Ee699Fb0ac4c952F19b298F5E2` |
| base-sepolia     | MyOFT         | `0x81129e01913aBE10AB620B1fBB91820783DcDBf2` |
| optimism-sepolia | MyOFT         | `0x81129e01913aBE10AB620B1fBB91820783DcDBf2` |

⚠️ **위 주소들은 `assignJob` 게이트(§1) 이전 버전입니다.** 게이트를 적용하려면 재배포·재와이어링이
필요하고, `dvn:preflight`가 이를 경고합니다. 그 외에도 **owner/operator 키는 작성자가 들고
있으므로**, 직접 트랜잭션을 보내려면 어차피 본인 키로 재배포해야 합니다.

동작 확인된 경로:

- clean 전송 → `VERIFY submitted` → `COMMIT driven` → 도착 (`allow`, score 0)
- veto → `VETO — withholding verification` → 미배달 + `recordVerdict` 기록 (`block`, score 100)

두 판정 모두 인덱서가 수집해 Postgres `risk_verdicts`에 남아 있습니다.

---

## 6. Quickstart

전체 배포 순서는 [DEPLOYMENT.md](DEPLOYMENT.md)에 있습니다. 여기서는 **이 브랜치를 처음
받았을 때** 필요한 것만 적습니다.

```bash
pnpm install
```

pnpm 워크스페이스 3개(루트 / `worker` / `indexer`)입니다. 루트와 두 패키지의 zod 버전이
다른 것은 의도적입니다 — LayerZero가 zod 3을 요구합니다.

**인덱서** (Docker):

```bash
cd indexer
```

```bash
cp .env.example .env
```

`FEED_SIGNING_KEY`(서명 전용 새 키), `DVN_*`, `TRACKED_TOKENS`, `TOKEN_MINIMUMS`를 채웁니다.
`TOKEN_MINIMUMS`가 비면 inbound 라벨이 아예 생기지 않으니 주의하세요.

```bash
docker compose up -d
```

**worker** (호스트에서 실행):

```bash
cd worker
```

```bash
cp .env.example .env
```

`OPERATOR_PRIVATE_KEY`, `DVN_*`, `INDEXER_FEED_URL`, `INDEXER_SIGNERS`를 채웁니다.
피드 URL을 주면서 서명자 allowlist를 비우면 worker는 **부팅을 거부합니다.**

```bash
pnpm start
```

**대시보드** (선택, `indexer/`에서):

```bash
docker compose --profile observability up -d
```

Grafana <http://localhost:3000/d/compliance-dvn-indexer> — datasource와 대시보드가
프로비저닝되어 있어 import가 필요 없습니다. worker 패널은
<http://localhost:3000/d/compliance-dvn-worker>.

---

## 7. 검증 상태

| 대상                | 결과           | 명령                                                  |
| ------------------- | -------------- | ----------------------------------------------------- |
| worker 단위 테스트  | **254 passed** | `cd worker && pnpm test`                              |
| indexer 단위 테스트 | **121 passed** | `cd indexer && pnpm test`                             |
| 컨트랙트 (hardhat)  | **15 passed**  | `npx hardhat test test/hardhat/ComplianceDVN.test.ts` |
| 타입 체크           | clean          | 각 패키지 `pnpm typecheck`                            |

`worker/`와 `indexer/`는 루트 prettier 대상이 **아닙니다** (`.prettierignore`에서 제외).
두 패키지에는 포맷터 스크립트가 없으므로 기준은 "주변 코드와 같게"입니다. 검증 게이트는
`typecheck` + `test`입니다.

**foundry 테스트는 실행되지 않았습니다** — `forge`가 이 환경에 설치돼 있지 않습니다.
`test/foundry/*.sol`은 새 ABI에 맞게 갱신했지만 미검증 상태입니다.

---

## 8. 알려진 미구현 / 주의사항

외부 의존성 때문에 의도적으로 남긴 것:

- **native 값 엣지** — 이벤트를 남기지 않으므로 trace API가 필요하고, 공용 RPC 대부분이
  제공하지 않습니다
- **`honeypot_suspect`** — 시뮬레이션이 필요합니다
- **깊이 4 이상 순회** — 정책상 3홉 고정(정책 v2)이므로 미구현이 아니라 결정 사항입니다

엔드투엔드로 확인되지 **않은** 경로:

- **manual-review → `approvePacket` 해제** — 피드 엔트리가 0이라 파생 라벨을 만들 수단이
  없어서 실제로 굴려보지 못했습니다. 단위 테스트와 hardhat 테스트로는 덮여 있습니다

기타:

- 루트 `tsc`에 기존 오류 2건 (`tasks/simple-workers-mock/wire.ts`의 `contractName` 누락).
  이 브랜치와 무관하며 손대지 않았습니다
- worker가 fail-closed 프리즈로 체크포인트를 붙잡기 때문에, 다운타임이 RPC의 `getLogs`
  상한(base sepolia 2000블록 ≈ 67분)을 넘으면 예전에는 영구히 못 따라잡았습니다. 청킹으로
  고쳤고 (`SCAN_CHUNK_BLOCKS`, 기본 2000) 회귀 테스트가 있습니다

---

## 9. 커밋 전 확인 사항

작성자가 푸시하기 전에 처리해야 합니다.

- [x] **`.env` 3개 모두 gitignore됨** — 루트 / `worker` / `indexer` 확인했습니다. `indexer/`는
      자체 `.gitignore` 없이 루트 패턴에 걸립니다 (`node_modules`, `.env` 모두 비앵커 패턴)
- [x] **`worker/.context/` gitignore 추가 완료** — 스캔 체크포인트·보류 큐·승인 목록이 든
      런타임 상태 파일입니다. 추적된 적이 없어 `git rm --cached`는 필요 없었습니다
- [x] `indexer/`에서 실제 커밋될 파일 38개 전수 확인 — 전부 소스·설정이고 런타임 상태나
      비밀은 없습니다
- [ ] **작업 중 실제 테스트넷 개인키가 대화에 노출됐습니다.** 자산이 없는 새 지갑이지만
      폐기하는 것을 권합니다
- [ ] `deployments/*/MyOFT.json`, `solcInputs/*.json` — 이 리포지토리는 배포 기록을 추적하는
      관례이므로 **포함**이 맞습니다
- [ ] `TEST_DENYLIST`가 데모용 `0x…dEaD`로 남아 있습니다. 정리 후 재시작 권장
- [ ] 커밋을 쪼갤 것: 컨트랙트 ABI 변경 / 리스크 엔진 / 인덱서 신규 / 관측·문서 정도로
      나누면 리뷰가 가능합니다. 지금은 49 + 64 파일이 한 덩어리입니다

---

## 10. 데모용 가짜 스테이블코인 (테스트넷 전용)

`contracts/mocks/FakeStablecoinMock.sol` — USDC 심볼을 주장하는 미끼 컨트랙트입니다. 가치가 없고
스테이블코인도 아니며, 리스크 엔진의 사칭 탐지를 실제로 굴려보기 위한 것입니다.

| 체인             | 주소                                         |
| ---------------- | -------------------------------------------- |
| base-sepolia     | `0x1B48E40F971298b03B6AD0Ae3CA047CD11b7eA6e` |
| optimism-sepolia | `0x7Ec44363Fdaa7EEC9B49a858220Ff543Bcd43ac7` |

한 컨트랙트로 두 신호를 보여줍니다 (실측 확인):

- 그대로 두면 `fake_stablecoin_suspect` 65점 → **manual-review**
- `worker/.env`의 `SCAM_TOKENS`에 주소를 넣으면 `scam_token` 100점 → **block**

수취인은 **도착 체인** 상태로 심사되므로, base→op 전송이면 op 쪽 주소를 수취인으로 지정해야 합니다.

### 데모용 컨트랙트 두 개 (테스트넷 전용)

| 컨트랙트             | 체인             | 주소                                         | 발화 신호                                                              |
| -------------------- | ---------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| `FakeStablecoinMock` | base-sepolia     | `0x1B48E40F971298b03B6AD0Ae3CA047CD11b7eA6e` | `fake_stablecoin_suspect` 65 → manual-review                           |
| `FakeStablecoinMock` | optimism-sepolia | `0x7Ec44363Fdaa7EEC9B49a858220Ff543Bcd43ac7` | (SCAM_TOKENS에 넣으면 `scam_token` 100 → block)                        |
| `RiskyProxyMock`     | optimism-sepolia | `0x9771013D82dcC2bdb489B982B4f201FD698A15e6` | `upgradeable_proxy` 15 + `contract_admin_risk` 50 = 65 → manual-review |

`RiskyProxyMock`은 EIP-1967 슬롯에 admin을 `0x…dEaD`(TEST_DENYLIST 주소)로 써 둡니다. 실권자가
오염된 업그레이더블 컨트랙트를 흉내내는 것이고, 다른 admin으로 배포하려면 `RISKY_ADMIN`을 주면
됩니다.

### 차단이 채널을 막는 문제와 `skip`

검증을 보류한 패킷은 그 nonce가 영구히 비어 있고, LayerZero 채널은 nonce를 순서대로만 처리하므로
**뒤의 정상 메시지가 모두 갇힙니다** (`LZ_InvalidNonce`). 해소는 `EndpointV2.skip`이며 OApp의
delegate(= owner)만 호출할 수 있습니다. 대시보드 "보류 패킷" 탭의 **메시지 채널 상태** 섹션이
막힌 nonce를 찾아 owner 서명으로 건너뛰게 해 줍니다.

### 데모 지연시간 설정

| 설정                        | 파일    | 값                                                              |
| --------------------------- | ------- | --------------------------------------------------------------- |
| `POLL_MS`                   | worker  | 3000                                                            |
| `SCAN_CONFIRMATIONS`        | worker  | 1 (온체인 증명값 `DVN_CONFIRMATIONS`=5는 ULN 요구조건이라 유지) |
| `FEED_REFRESH_MS`           | worker  | 5000 — 피드만 재수신 (전체 재빌드는 60초)                       |
| `POLL_MS` / `CONFIRMATIONS` | indexer | 5000 / 1                                                        |
| `FEED_REBUILD_MS`           | indexer | 60000 — 단, **새 엣지가 잡히면 즉시 재발행**                    |

전송 → 판정 ≈ 3.5초, 그래프 라벨 반영 ≈ 10초.
