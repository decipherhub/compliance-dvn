# demo/

데모 전용 자산 모음. 프로덕션 파이프라인(컨트랙트 컴파일, worker/indexer 서비스, 테스트)은 이 폴더
없이도 완결적으로 동작하며, 여기 있는 것들은 전부 시연을 위한 것이다.

## 구성

| 경로         | 내용                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------- |
| `dashboard/` | 데모 대시보드 — MetaMask 크로스체인 전송, owner 승인/거절, 제재 목록·판정 로그, 홉 그래프     |
| `contracts/` | 데모 전용 컨트랙트 소스 (`FakeStablecoinMock`, `RiskyProxyMock`)                              |
| `prebuilt/`  | 위 소스의 컴파일 아티팩트 — 메인 파이프라인이 컴파일하지 않으므로 배포 스크립트가 이걸 사용   |
| `deploy/`    | 데모 컨트랙트 hardhat-deploy 스크립트 (`FakeUsdcOFT`, `RiskyProxyMock`, `FakeStablecoinMock`) |
| `script/`    | `mintDemo.ts` — 데모 지갑 5개에 토큰 100개씩 발행 (idempotent)                                |

## 대시보드 실행

```bash
cd demo/dashboard
python serve.py            # http://localhost:8080
```

배포 주소·체인·라벨은 전부 `dashboard/config.js`에 있다. 페이지는 정적 파일이고, 모든 쓰기는
MetaMask 서명으로만 이루어진다 — 키가 이 폴더나 백엔드에 들어올 일이 없다.

## 데모 컨트랙트 배포

배포 스크립트는 hardhat 설정의 `paths.deploy`(`['deploy', 'demo/deploy']`)로 발견되므로 평소처럼
태그로 선택해 실행한다:

```bash
npx hardhat deploy --network base-sepolia --tags RiskyProxyMock
npx hardhat deploy --network base-sepolia --tags FakeUsdcOFT    # MyOFT 아티팩트 사용, 별도 wiring 필요
```

`FakeUsdcOFT`는 `contracts/MyOFT.sol`(메인 트리, 계속 컴파일됨)을 쓰므로 prebuilt가 필요 없다.
`RiskyProxyMock`/`FakeStablecoinMock`은 `prebuilt/`의 아티팩트로 배포된다.

### prebuilt 재생성

`demo/contracts/*.sol`을 수정했다면, 파일을 잠시 `contracts/mocks/`로 복사해 컴파일한 뒤 아티팩트를
다시 가져온다:

```bash
cp demo/contracts/RiskyProxyMock.sol contracts/mocks/
npx hardhat compile
cp artifacts/contracts/mocks/RiskyProxyMock.sol/RiskyProxyMock.json demo/prebuilt/
rm contracts/mocks/RiskyProxyMock.sol
```

## 토큰 발행

```bash
npx hardhat run demo/script/mintDemo.ts --network base-sepolia
TOKEN=FakeUsdcOFT npx hardhat run demo/script/mintDemo.ts --network base-sepolia
```

발행 대상 지갑 목록은 스크립트 상단의 `DEMO_WALLETS`에 있다.

## 주의

- 여기 있는 토큰은 전부 open-mint 테스트넷 전용이다. 가치가 있는 네트워크에 배포하지 말 것.
- `FakeStablecoinMock`은 초기 시나리오의 잔재로 현재 대시보드는 사용하지 않는다 (수취인 기반 미끼
  → 전송 토큰 기반 `FakeUsdcOFT`로 대체됨). 배포 기록이 있어 보존한다.
