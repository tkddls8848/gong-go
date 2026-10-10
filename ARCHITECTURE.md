# Architecture

이상적인 구조가 아니라 **현재 실제 구조**를 적습니다. 파일 위치는 [기능별 코드 지도](docs/code-map.md), 변경 규칙은 [AGENTS.md](AGENTS.md)를 봅니다.

## System Overview

나라장터(조달청) 공고를 수집해 저장하고, 로그인 게이트 뒤에서 검색·조회하게 하며, 제안요청서 첨부에서 장비 규격(ECR)을 AI로 추출하는 서비스입니다.

실행 주체가 네 종류입니다.

- **Cloudflare Worker** (`src/`) — 요청 처리, 인증, R2 제공, AI 핸들러, cron 진입점
- **GitHub Actions** (`.github/workflows/`) — 수집·업로드 실행
- **브라우저** (`public/`) — 화면. Worker의 `ASSETS` 바인딩으로 배포됨
- **로컬 PC** (`downloader/`, `analyzer/`, `tools/`) — 첨부 다운로드, 로컬 분석, 평가 도구

## Directory Structure

| 디렉터리 | 실행 주체 | 진입점 | 책임 |
| --- | --- | --- | --- |
| `src/` | Worker | `worker.js` (`fetch`, `scheduled`) | 인증 순서, 라우팅, R2 제공, AI, cron |
| `public/` | 브라우저 | `index.html` → 스크립트 → `app.js` | 화면 조립, 검색, ECR UI, 내보내기 |
| `collector/` | Actions, 로컬 | `collector.js main()` | 수집, 압축, 인덱스 생성 |
| `uploader/` | Actions, 로컬 | `upload.js main()` | R2 업로드, 인덱스 반영, 점검 |
| `downloader/` | 로컬 | `attachments.js main()` | 첨부 다운로드 |
| `analyzer/` | 로컬 (CLI 전용) | `analyze.js` | 로컬 2-pass ECR 추출. **운영 경로가 아니다** |
| `test/` | `npm test` | — | 화면 테스트 + 모듈 간 계약 테스트 |
| `tools/` | 수동·CI | — | smoke·부하·선별 평가 |
| `docs/` | 사람 | `code-map.md` | 탐색 진입점과 운영 설명 |

## Major Domains

- **수집** — `collector/`(+`src/relay.js`를 통한 상류 호출)
- **저장·제공** — `uploader/` → R2 `gong-go-data` → `src/data.js`
- **조회** — `public/search*.js`, `public/rows.js`, `public/data-index.js` + `src/live.js`
- **ECR 분석** — `src/ecr*.js`(운영), `public/ecr-*.js`·`equipment.js`(표시), `analyzer/`(로컬 대안), `tools/eval-*`(평가)
- **인증·권한·예산** — `src/gate.js`, `src/ai-access.js`, `src/ai-budget.js`

ECR이 가장 넓게 퍼진 도메인입니다. 운영 형식을 바꿀 때는 네 곳을 함께 봐야 합니다.

## Dependency Direction

```
[apis.data.go.kr] <-HTTP- src/relay.js <-Bearer- collector/api.js
        ^                                             | fs
        +-HTTP- src/live.js <- public/search.js        v
                                     data/{mode}/*.csv.gz, data/index.json
[GitHub Actions] <-dispatch- src/refresh.js            | fs
      +- collect.yml -> collector -> uploader -S3-> [R2] <- downloader(로컬)
                                        src/data.js <-R2 get-+
                                             ^
                        public/data-index.js, search-scan, search-worker
[Workers AI] <- src/ai-budget.runBudgeted <- src/ecr.js, src/ask-handler.js
```

규칙과 실제가 일치합니다.

- **최상위 운영 모듈(`collector`, `downloader`, `analyzer`, `uploader`, `src`, `public`) 사이에 런타임 import가 없습니다.** 결합은 데이터 계약(CSV·`index.json`·`data/` 구조)과 HTTP 계약으로만 생깁니다.
- 흐름은 생산 → 운반 → 저장 → 제공 → 소비 한 방향이고 순환이 없습니다.
- `src/` 내부는 라우터(`worker.js`) → 핸들러 → 잎 유틸 3단입니다.
- `public/` 내부는 `app.js`(조립) → 기능 생성 함수 → 잎(`rows`/`http`/`dates`/`format`)입니다. 기능 모듈끼리 직접 import하지 않고 주입이나 `scope.GongX` 기본값으로 연결합니다.
- Worker와 수집기는 HTTP 두 지점에서 양방향으로 엮입니다: collector가 relay를 호출하고, Worker의 `scheduled`가 collect 워크플로를 `workflow_dispatch`로 건다.

## Request / Data Flow

**조회 요청** — 요청 → `worker.js`의 게이트(쿠키 검사, robots·relay 예외가 게이트 앞) → 라우팅 → `data.js`가 경로 화이트리스트를 거쳐 R2 읽기 → 브라우저가 CSV를 스트리밍 파싱.

**수집** — Worker cron(UTC `0 0-9 * * *` = KST 09~18시 정각) 또는 화면 버튼 → `refresh.js`가 `workflow_dispatch` → Actions에서 `collector` → `uploader` → R2 → `index.json` 갱신.

**ECR 분석** — 브라우저가 첨부 텍스트 업로드 → `ecr.js`가 작업 키 배치와 lease 잠금 → `ecr-source.js`가 상세 요구사항 표를 선별 → 구간을 Workers AI에 보냄 → 결과 병합 → **결과를 저장하지 않고** 응답. 화면이 `equipment.js`로 검증해 표시.

## Persistence

- **R2 `gong-go-data`** — 운영 저장소. `src/data.js`가 경로 화이트리스트로만 읽습니다.
- **`data/`** — 로컬·러너 산출물. 규약은 `data/files/bid/<공고번호>/`, `data/text/bid/<공고번호>/manifest.json`. 이 규약은 별도 저장소(`orca/convertors`)의 변환기와 맞추는 경계입니다.
- **계약** — CSV 열과 `index.json` 항목 규칙이 모듈 사이의 실질 계약입니다. README의 계약 표와 작성기·독자 테스트를 함께 봅니다.
- **DB도 migration도 없습니다.** 스키마 변경은 CSV·인덱스 형식 변경과 `SCHEMA_VERSION` 취급으로 나타납니다.
- ECR 분석 결과는 저장하지 않습니다(`src/ecr.js`). 작업 키만 R2에 두고 정리합니다.

## External Services

| 서비스 | 호출 지점 | 인증 |
| --- | --- | --- |
| `apis.data.go.kr` | `src/relay.js`(수집기 중계), `src/live.js`(최신 공고) | 서비스 키 |
| GitHub Actions | `src/refresh.js` → `workflow_dispatch` | 토큰 |
| Workers AI | `src/ai-budget.runBudgeted` | `AI` 바인딩 |
| R2 | `src/data.js`(Worker), `uploader/`(S3 API) | 바인딩 / 액세스 키 |

## Authentication / Authorization

- **조회 게이트** — `src/gate.js`. 비밀번호 → 쿠키. 게이트는 라우팅보다 앞에 있고, 예외는 robots와 relay뿐입니다(`worker.js`).
- **AI 2차 권한** — `src/ai-access.js`. 조회 로그인과 별개의 쿠키와 서버 권한입니다. 잠금 해제·재잠금이 서버 권한까지 바꿉니다.
- **relay** — `Bearer DATA_GO_KR_RELAY_TOKEN`. 수집기만 호출합니다.
- **예산** — `src/ai-budget.js`가 일일 뉴런 한도를 예약·정산합니다. 예약을 되돌릴 근거가 없으면 그대로 둬 초과 사용 쪽으로 기울지 않습니다.

## Error Handling

이 저장소의 사실상 표준 패턴입니다. 새 코드는 이것을 따릅니다.

- 사용자에게는 **무엇을 해야 하는지** 알려주는 한국어 문구를 주고, 내부 메시지·스택을 노출하지 않습니다.
- 실패를 성공으로 표시하지 않습니다(저장 실패 시 성공 표시 금지).
- 복구 가능한 실패는 재시도하고, 한도 초과는 예약을 유지합니다.
- ECR 실패는 `{"event":"ecr_failure","stage":...}` 구조 로그로 남깁니다.
- 빈 catch를 두지 않습니다.

## Testing Strategy

```
npm test                        # 기본. node --test. 약 457건 1초대
npm run test:browser            # 화면 연결 변경 시(설치된 Edge/Chromium headless)
npm run test:runtime            # Worker 연결 변경 시(workerd + 비영속 R2)
npm run test:selection          # ECR 표 선별 변경 시(저장소 밖 실문서 필요)
npx wrangler deploy --dry-run   # 번들 변경 시
```

- **위치 규칙**: 화면 테스트는 `test/`, 나머지는 구현 옆에 둡니다. 예외가 없습니다.
- 테스트는 모듈을 직접 호출합니다. 함수 소스를 문자열로 잘라 실행하지 않습니다.
- 계약 테스트는 모듈 경계를 넘어 작성기와 독자를 연결할 수 있습니다. 런타임 코드는 그럴 수 없습니다.
- CI(`.github/workflows/quality.yml`)가 `npm test`, `test:runtime`, `npm audit`, dry-run, `test:browser`, `test:search-load`를 돕니다. **`test:selection`은 CI에 없습니다** — 실문서가 저장소 밖에 있어 그 자료가 있는 PC에서 따로 돌립니다.
- **typecheck와 lint 명령은 없습니다.** TypeScript를 쓰지 않고 린터 설정도 없습니다. 타입 안전은 런타임 검증(`public/equipment.js`의 `validate`, `src/ask.js`의 스키마 파싱)과 계약 테스트로만 확보합니다. 찾지 마십시오.

## Important Constraints

- **모듈 경계** — 최상위 운영 모듈 사이에 런타임 import를 만들지 않습니다. 같은 기능의 사본(CSV 파서 3벌, 인덱스 규칙 2벌, Node 유틸, 서비스 표)은 **의도된 것입니다.** 합치지 말고 계약 테스트로 묶여 있는지 확인합니다.
- **ECR 구간 상한 33** — 임의값이 아닙니다. 무료 Worker의 요청당 subrequest 한도 50에서 예산 재시도와 구간 표식 몫을 뺀 역산값입니다.
- **`src/ecr.js`의 `VERSION`** — 표 선별이나 구간 나누기를 고치면 반드시 올립니다. 올리지 않으면 예전 방식으로 자른 구간을 재사용해 고친 것이 반영되지 않습니다.
- **`public/`은 전부 배포됩니다.** 임시 파일을 두지 않습니다.
- **Node 22.7 이상** (`package.json`의 `engines`). `package.json`에 `"type"`이 없습니다 — `src/`는 ESM, 나머지는 CJS입니다. `"type"`을 추가하면 한쪽이 깨집니다.
- **`docs/history/`** 는 과거 기록입니다. 현재 계획이나 배포 상태로 읽지 않습니다.
- **main 푸시가 곧 운영 배포입니다.** Cloudflare Workers Builds가 저장소에 연결되어 main 푸시마다 빌드 명령(`npm test`) 뒤 `npx wrangler deploy`를 실행합니다. GitHub의 quality 워크플로와는 따로 돌기 때문에, quality가 실패해도 Workers Builds의 `npm test`가 통과하면 배포됩니다. `npm run deploy`는 수동 배포가 필요할 때만 씁니다.
