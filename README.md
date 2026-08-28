# 나라장터 공고·ECR 조회

나라장터 사전공고·본공고·발주계획을 수집해 검색하고, 본공고 첨부 문서에서 ECR 규격을 추출하는 개인용 서비스입니다. 운영 경로는 Cloudflare Worker + R2이며, GitHub Actions가 업무 시간대(KST 09~18시)에는 매시 당일치를, 매일 새벽에는 최근 35일을 다시 수집합니다.

## 구성

- `collector/`: 공공데이터 API 수집, 일별 gzip CSV 저장, 지난 월 봉인
- `downloader/` → `converter/` → `analyzer/`: 첨부 다운로드, HWPX/Markdown 변환, ECR 분석
- `uploader/`: 변경된 서비스 CSV·raw 원본·분석 결과만 R2 업로드
- `public/`: 조회 화면. `app.js`가 화면을, `search-worker.js`가 CSV 스캔을, `rows.js`가 둘이 공유하는 파서와 행 모델을 맡는다
- `src/worker.js`: 비밀번호 인증, 정적 자산/R2 제공, 원격 갱신 실행, 공공데이터 API 중계, 고급검색 해석
- `shared/`: CSV와 파이프라인 공용 함수. `nl-filter.js`는 Worker와 로컬 서버가 함께 쓰는 자연어 해석 순수 함수다
- `test/`: 조회 화면용 테스트. 나머지 테스트는 대상 옆에 두지만 이것만 떼어 놓는다 — `public/`은 wrangler의 자산 디렉터리라 그 안의 파일은 전부 사이트로 배포된다

산출물은 모두 gitignore된 `data/`에 저장합니다.

```text
data/
├─ pre|bid|plan/YYYY/MM/DD.csv.gz   일별 서비스 데이터
├─ pre|bid|plan/YYYY/MM.csv.gz      봉인된 월 데이터
├─ raw/pre|bid|plan/...             원본 컬럼 백업
├─ files|norm|text/bid/...     첨부와 변환 결과
└─ analysis/bid/...            ECR 분석 결과
```

## 준비

Node.js 20 이상에서 설치하고 `.env.example`을 `.env`로 복사해 필요한 값을 채웁니다.

```powershell
npm ci
```

주요 환경변수는 다음과 같습니다.

- `SERVICE_KEY`: 공공데이터포털 일반 인증키(Decoding)
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: R2 업로드
- `ANTHROPIC_API_KEY`: Anthropic 분석을 사용할 때만 필요
- `GATE_PASSWORD`: Worker 조회 화면 비밀번호
- `GITHUB_TOKEN`: 배포 화면의 갱신 버튼용 GitHub fine-grained PAT. 이 저장소의 Actions read/write 권한만 부여
- `API_BASE`, `RELAY_TOKEN`: 공공데이터 API 중계 경유 설정. 로컬에서는 비워 둡니다([공공데이터 API 중계](#공공데이터-api-중계) 참고)

## 로컬 실행

```powershell
npm run collect       # collector/sync.config.json 기준 수집
npm run serve         # http://127.0.0.1:8788/public/
npm test
```

조회 화면의 갱신 버튼은 로컬에서 수집기를 직접 실행합니다. 기간을 일시적으로 바꾸려면 다음처럼 실행합니다.

```powershell
node collector/collector.js --begin=2026-08-01 --end=2026-08-09 --no-resume
```

## 첨부·ECR 파이프라인

`downloader/download.config.json`에서 기관과 파일명 조건을 정한 뒤 순서대로 실행합니다. HWP 변환은 Windows에 설치된 한글 COM을 사용합니다.

```powershell
npm run attachments
npm run convert
npm run analyze -- --provider ollama --model qwen3.5-hermes-64k:latest
```

유료 분석 전에는 `--dry-run`으로 입력 토큰과 예상 비용을 확인합니다.

## 공공데이터 API 중계

GitHub Actions 러너에서는 `apis.data.go.kr:443`으로 TCP 연결이 성립하지 않습니다. 거부가 아니라 타임아웃이고, 같은 코드가 국내에서는 33ms 만에 붙습니다. 차단 기준은 국가가 아니라 **IP 대역**입니다 — Cloudflare 엣지에서는 미국 LAX colo에서도 155~515ms로 응답이 옵니다. 그래서 러너의 수집 요청만 Worker가 대신 내보냅니다.

```text
수집기(러너) --Bearer RELAY_TOKEN--> Worker /api/relay --> apis.data.go.kr
```

`API_BASE`가 비어 있으면 수집기는 `apis.data.go.kr`을 직접 부릅니다. 국내 로컬은 설정할 필요가 없고, 러너에서만 중계를 탑니다.

중계는 두 가지로 제한됩니다.

- **경로 화이트리스트**: `src/worker.js`의 `RELAY_ALLOW`에 적힌 세 서비스만 통과합니다. 임의 URL을 받아 주면 이 Worker가 공개 프록시가 됩니다.
- **기계용 토큰**: 조회 화면의 비밀번호 게이트와 분리해 `Authorization: Bearer`로만 인증합니다. 게이트보다 먼저 처리하므로 러너에 로그인 화면이 돌아가지 않습니다.

### 토큰 등록

토큰을 만들고 **Cloudflare와 GitHub 양쪽에 같은 값**을 넣습니다.

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **`wrangler secret put`을 비대화형 셸에서 실행하지 마세요.** 숨김 입력 프롬프트가 EOF를 읽어 **빈 값이 등록**됩니다. 프롬프트 없이 곧바로 성공 메시지가 찍혀 사고를 알아채기 어렵습니다(과거 `GATE_PASSWORD`가 이렇게 두 번 비었습니다). 직접 연 터미널이나 Cloudflare 대시보드에서만 등록합니다.

```powershell
npx wrangler secret put RELAY_TOKEN      # 직접 연 터미널에서
npm run deploy

gh secret set RELAY_TOKEN --repo tkddls8848/gong-go
gh secret set API_BASE --repo tkddls8848/gong-go --body "https://gong-go.<계정>.workers.dev/api/relay"
```

`API_BASE`를 비워 두면 러너가 직접 호출로 되돌아가 다시 타임아웃납니다.

### 확인

배포 후 토큰이 비지 않았는지 응답 코드로 확인합니다. 토큰 없이 부르면 **401이 나와야 정상**입니다.

```powershell
curl -s -o NUL -w "%{http_code}`n" "https://gong-go.<계정>.workers.dev/api/relay/1230000/ad/BidPublicInfoService/getBidPblancListInfoThngPPSSrch"
```

**상태 코드만으로는 부족합니다.** 중계 경로가 없는 구 배포본도 조회 화면의 게이트가 로그인
화면을 401로 돌려주기 때문에, 정상일 때와 코드가 같습니다. 본문까지 봐야 구분됩니다.

```powershell
curl -s -i "https://gong-go.<계정>.workers.dev/api/relay/1230000/ad/BidPublicInfoService/getBidPblancListInfoThngPPSSrch" | Select-String "HTTP/|content-type"
```

| 응답 | 본문 | 뜻 |
|---|---|---|
| 401 | JSON `중계 토큰이 올바르지 않습니다` | 정상. 시크릿이 있고 인증이 동작합니다 |
| 401 | HTML 로그인 화면 | 중계 경로가 없는 **구 배포본**입니다. `npm run deploy` 하세요 |
| **501** | JSON `RELAY_TOKEN 시크릿이 설정되지 않았습니다` | **시크릿이 비었거나 이름이 다릅니다** |

## R2 업로드와 배포

```powershell
npm run compact              # 40일보다 오래된 월을 봉인
npm run compact -- --prune   # 봉인 확인 후 같은 월의 일별 파일 삭제
npm run upload               # 기본값: 변경·삭제 예정 내역만 확인(dry-run)
node uploader/upload.js --commit  # 확인한 내용을 실제 R2에 반영
npx wrangler secret put GATE_PASSWORD
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put RELAY_TOKEN     # 이름이 정확해야 한다 — 아래 주의 참고
npx wrangler secret put SERVICE_KEY     # 저장 결과 위에 최신 공고를 합치는 /api/live용
npm run deploy
```

수집기가 만드는 `data/raw/{pre,bid,plan}/YYYY/MM/DD.csv.gz`도 같은 구조의
`raw/{pre,bid,plan}/YYYY/MM/DD.csv.gz` R2 객체로 업로드한다. Worker의 공개 데이터 경로에는
raw 프리픽스를 허용하지 않으므로 사이트 방문자가 원본 백업을 직접 내려받지는 못한다.
명시한 재수집 구간에서 공고가 사라지면 서비스 일별 파일과 대응 raw 객체를 함께 정리한다.

과거 데이터에 새 컬럼을 소급할 때는 GitHub Actions의 `historical-backfill`을 실행한다. 기본 범위는
`2020-01-01 ~ 2026-03-31`이며 3개월씩 순차 처리한다. 과거 조회가 가능한 사전공고와 본공고를
다시 받아 현재 컬럼으로 만든 월별 서비스 CSV와 전체 컬럼 raw 일별 CSV를 함께 R2에 넣는다.
개별 백필 작업은 `--put-only` 업로드라 운영 `index.json`과 원격 삭제를 건드리지 않는다.
모든 작업이 성공한 뒤에만 최종 작업이 `index.json.schemaVersion`을 올린다. 화면은 이 값을
CSV URL에 붙여 기존 1년 immutable 캐시를 새 데이터로 한 번 교체한다. 발주계획 API는 과거
범위 조회를 지원하지 않아 역사 백필 대상에서 제외된다.

> 시크릿 이름은 코드가 읽는 것과 **정확히** 같아야 합니다. Worker는 `env.RELAY_TOKEN`을
> 읽으므로 `RELAY` 같은 다른 이름으로 등록하면 값이 들어 있어도 중계가 501을 반환합니다.
> 네 개 모두 비대화형 셸에서 등록하지 마세요(아래 [토큰 등록](#토큰-등록) 경고 참고).

Cloudflare 시크릿은 `GATE_PASSWORD`, `GITHUB_TOKEN`, `RELAY_TOKEN`, `SERVICE_KEY` 네 개입니다. `GITHUB_TOKEN`이 없으면 배포 화면의 갱신 API가, `RELAY_TOKEN`이 없으면 수집 중계가, `SERVICE_KEY`가 없으면 최신 공고 합치기가 501을 반환합니다. GitHub 저장소에도 Actions용 `SERVICE_KEY`, `API_BASE`, `RELAY_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`를 등록해야 합니다.

수집은 `.github/workflows/collect.yml` 하나가 다 하고, 그것을 **거는 경로가 셋**입니다.

| 거는 쪽 | 시각 | GitHub 이벤트 | 수집 범위 |
| --- | --- | --- | --- |
| Worker Cron Trigger (`wrangler.jsonc`의 `triggers.crons` → `src/worker.js`의 `scheduled`) | `0 0-9 * * *` UTC = KST 09~18시 정각, 하루 10회 | `workflow_dispatch` | 어제~오늘 |
| GitHub `schedule` | `0 20 * * *` UTC = KST 05:00 | `schedule` | 오늘과 이전 35일 |
| 배포 화면의 갱신 버튼 | 누를 때 | `workflow_dispatch` | 어제~오늘 (매시 크론과 같음) |
| GitHub에서 수동 실행 | 누를 때 | `workflow_dispatch` | 입력값, 비우면 오늘과 이전 35일 |

**매시 갱신을 Worker가 거는 이유**는 GitHub의 `schedule`이 최선 노력이라 혼잡 시간대에 수십 분씩 밀리기 때문입니다. 그 지연 위에서는 "당일 공고를 한 시간 안에"가 성립하지 않습니다. Cloudflare Cron Trigger는 예정 시각에 거의 그대로 뜨므로 트리거만 그쪽으로 옮겼고, 수집 자체는 그대로 GitHub 러너에서 돕니다. 다만 정시성은 **트리거 시각**의 정시성입니다 — 러너 준비와 수집에 다시 1~2분이 걸리므로 R2 반영은 그만큼 뒤입니다.

**크론과 갱신 버튼이 같은 `workflow_dispatch`를 씁니다.** 둘을 갈라 주는 `repository_dispatch`를 먼저 썼다가 되돌렸습니다 — 그쪽은 `workflow_dispatch`(Actions 쓰기)와 달리 저장소 **Contents 쓰기**를 요구하는데, `GITHUB_TOKEN`은 Actions read/write만 가지고 있어 403이 납니다. 토큰을 넓히는 것보다 같은 문을 쓰는 편이 낫다고 봤습니다.

같은 문을 써도 버튼이 크론 실행의 결과를 제 것으로 보고하지는 않습니다. 다만 그 근거는 실행 id가 **아닙니다** — `workflow_dispatch`는 204 No Content라 id를 주지 않습니다. 대신 버튼은 dispatch 시각을 받아 `?since=`로 묻고, Worker는 `created>=`를 붙여 그 뒤에 만들어진 실행만 봅니다. GitHub이 실행을 아직 만들지 않았으면 "없음"이 아니라 대기로 답합니다 — 여기서 완료로 답하면 방금 건 갱신이 시작도 전에 끝난 것으로 보입니다. 실행 id가 조회에 처음 잡히는 순간 화면이 거기에 고정하므로(`?runId=`), 폴링 도중 매시 크론이 새 실행을 걸어도 추적 대상이 갈아타지 않습니다. 2분이 넘도록 실행이 등록되지 않으면 폴링을 끊고 Actions 탭을 확인하라고 알립니다.

`since` 없이 최근 `workflow_dispatch` 실행 하나를 보는 경로(`handleRefresh`의 `runId`·`since` 없는 분기)로 내려가는 것은 갱신 중에 페이지를 새로 열어 `resumeRefresh`가 상태를 되찾을 때뿐입니다. 그때는 크론 실행을 보고 진행/완료를 표시할 수 있는데, 수집 자체는 정상이고 표시만 어긋납니다.

**범위를 나눈 이유**는 비용입니다. 본공고 한 페이지가 5~6MB라 매시 36일치를 다시 훑으면 하루에 수 GB를 나라장터에서 되받습니다. 매시 범위를 오늘 하루가 아니라 **어제~오늘**로 잡은 것은, 전날 18시 실행 뒤에 등록된 공고가 어제 날짜로 남아 다음 날 05:00까지 들어오지 못하기 때문입니다. 이틀은 28일 청크 하나에 들어가므로 작업 수는 그대로이고 페이지 수만 늡니다.

`wrangler.jsonc`의 크론 식은 **UTC로만** 해석됩니다(KST 표기가 없습니다). 크론 트리거는 `npm run deploy`로 배포해야 등록되며, 로컬에서는 `npx wrangler dev --test-scheduled` 뒤 `curl "http://localhost:8787/__scheduled"`로 확인합니다.

### 갱신에 걸리는 시간

2026-08-11의 수동 실행 한 건(run `31491773531`)에서는 버튼부터 완료까지 111초가 걸렸습니다. 러너 준비 18.1초, 수집 80.6초, 업로드 7.9초, 마무리 4.4초였습니다. 현재 구성의 성공 표본이 한 건뿐이므로 111초를 장기 중앙값으로 보지는 마세요.

- **러너 준비**: `npm ci --omit=dev` 자체는 위 실행에서 1.45초였습니다. 더 큰 비용이던 Node 20 다운로드와 72MB의 오래된 npm 캐시 복원을 피하도록, 워크플로는 러너 tool cache에 있는 Node 22를 쓰고 의존성은 수집 뒤 uploader 직전에 설치합니다.
- **수집 루프**: 정상 실행의 전체 요청은 약 45~47회뿐이고, 위 실행에서는 동시 요청 8개로도 수집에 80.6초가 걸렸습니다. 요청 수보다 요청별 지연을 먼저 봐야 합니다. 로그의 `HTTP` JSON에는 ServiceKey가 든 URL 대신 `mode/type/range/page`, `queueWaitMs`, `fetchMs`, `status`, `bytes`, `retry`, Worker가 돌려준 `upstreamMs`만 남습니다.
- **동시 요청 수와 페이지 크기**: 요청별 계측 없이 `concurrency`나 `numOfRows`부터 올리지 마세요. 상대 서버 부하와 429 위험이 함께 커집니다. 한 번 실행한 뒤 `queueWaitMs`와 `fetchMs` 분포를 보고 결정하고, 변경할 때는 한 단계씩 적용한 뒤 `data/sync-errors.json`을 확인하세요.
- **브라우저 반영**: 최근 일별 CSV는 최대 300초 캐시되지만, 갱신 완료 직후 현재 선택된 최근 파일은 `cache: "no-cache"`로 한 번 조건부 재검증합니다. URL을 바꾸지 않으므로 바뀌지 않은 파일은 ETag로 304 응답을 받고 기존 캐시를 계속 씁니다.
- **완료 감지**: 화면은 진행 상태를 폴링합니다. 시작 60초 안쪽이면 2초, 넘어가면 5초 간격입니다(`public/app.js`의 `pollDelay`). 버튼 실행이 30초대에 끝나므로 촘촘한 쪽이 기본이고, 60초를 넘기는 것은 35일 재수집이거나 큐에 걸린 쪽이라 그때만 느슨해집니다. 예전에는 이 조건이 뒤집혀 있어 버튼 경로가 언제나 5초 간격만 썼고, 이미 끝난 실행을 최대 5초 늦게 알아챘습니다.
- **큐 대기**: `collect.yml`의 `concurrency`(`group: collect`, `cancel-in-progress: false`)가 실행을 직렬화합니다. 앞 실행이 도는 동안 건 dispatch는 러너조차 잡지 못하고 기다립니다 — 09시 정각 크론과 겹친 버튼이 큐에서만 **85초**를 썼습니다(run `32709162111`: run created 09:00:11, job created 09:01:36, 총 2분 3초). 아래 "이미 도는 실행에 붙는다"가 이 구간을 없앱니다.

위 111초는 **오늘과 이전 35일**(양끝 포함 36개 날짜)을 받은 실행입니다. 지금 이 범위로 도는 것은 새벽 크론뿐이고, 매시 크론과 갱신 버튼은 어제~오늘만 받습니다 — 2026-08-14의 실측으로 12개 작업·2,489건에 **26초**였습니다. 넓은 범위를 없애지 않는 이유는 나라장터가 지난 공고를 소급 수정하기 때문입니다. 어제 하루만 받으면 그 사이 바뀐 건을 놓치므로, 소급분은 새벽 실행이 따로 훑습니다.

갱신 버튼으로는 이제 35일 전체를 다시 받을 수 없습니다. 필요하면 GitHub Actions에서 `collect`를 입력값 없이 수동 실행하세요.

### 이미 도는 실행에 붙는다

버튼을 눌렀을 때 끝나지 않은 `collect` 실행이 있으면, Worker는 **새로 걸지 않고 그 실행에 붙습니다** — 응답이 `409`이고 본문에 그 실행의 `runId`가 실립니다. 화면은 409를 오류로 보지 않고 그 id로 폴링을 이어 갑니다.

근거는 두 가지입니다. 하나는 위의 큐 대기 — 어차피 앞 실행이 끝나야 시작하므로 새 실행을 걸어 봐야 기다리는 시간만 늘어납니다. 다른 하나는 범위 — 매시 크론과 버튼은 같은 어제~오늘을 받으므로 돌고 있는 그 실행이 곧 버튼이 원하는 결과입니다.

찾을 때 **이벤트를 가리지 않습니다.** concurrency group은 이벤트와 무관하게 하나로 묶이므로 새벽 `schedule` 실행(35일 재수집)도 버튼을 줄 세웁니다. 상태 조회 쪽이 `event=workflow_dispatch`로 거르는 것과 목적이 다릅니다 — 거기서는 "내가 건 실행"을 집어야 하고, 여기서는 "나를 막을 실행"을 찾습니다.

붙을 때는 **범위를 싣지 않습니다.** 실행 정보는 `workflow_dispatch`의 `inputs`를 되돌려주지 않아 그 실행이 어느 구간을 받는 중인지 알 수 없습니다. 그래서 진행·완료 문구의 구간이 그때만 `-`로 남습니다 — 지어내는 것보다 낫다고 봤습니다.

붙는 것은 나라장터 API를 한 번도 더 부르지 않으므로 **하루 한도와 쿨다운을 세지 않습니다.** 다만 그 둘은 이 조회보다 **먼저** 봅니다. 한도를 넘긴 요청은 GitHub에 아무것도 묻지 않는다는 성질을 그대로 두기 위해서입니다. 조회 자체가 실패하면 막지 않고 예전처럼 그냥 dispatch합니다 — 최악이라도 지금까지처럼 큐에서 기다릴 뿐입니다.

## 조회 화면이 긴 구간을 다루는 방법

검색은 **저장 결과 우선, 최신 결과 후속 반영** 순서로 동작한다. 먼저 R2의 CSV 검색 결과를
표에 확정해 사용자가 나라장터 응답을 빈 화면으로 기다리지 않게 한다. 조회 기간이 어제~오늘과
겹치면 인증된 `/api/live`가 그 겹치는 구간만 공공 API에서 확인하고, 브라우저가 같은 필터를
적용해 공고번호 기준으로 기존 행을 교체하거나 새 행을 추가한다. 이 행에는 `최신 확인` 배지가
붙는다. 공공 API가 실패해도 먼저 표시한 저장 결과는 그대로 남는다.

실시간 쪽은 한 페이지 100건으로 먼저 응답하고 나머지 페이지를 최대 4개씩 받는다. Worker는
큰 JSON을 파싱하지 않고 서비스 키를 붙인 원문 응답만 `no-store`로 전달한다. 검색 기간 중
과거 구간은 이미 저장된 CSV만 사용하며, 전체 정합성·소급 수정 반영은 기존 매시/새벽 수집이
계속 책임진다. 로컬 `npm run serve`도 `.env`의 `SERVICE_KEY`로 같은 경로를 제공한다.

조회는 인덱스에서 고른 `.csv.gz`를 브라우저가 직접 받아 훑는 방식이다. 구간이 길어지면 파일 수가 그대로 일거리가 되므로 네 가지로 줄인다.

- **모드별로만 받는다.** 인덱스 항목의 `mode`가 화면의 토글과 같은 것만 고른다. 날짜만 보고 고르면 사전공고를 보는데 본공고·발주계획까지 받아 풀고 파싱한 뒤 버린다.
- **스캔은 워커에서 돈다.** `search-worker.js`를 코어 수에 맞춰 최대 3~4개 띄우고 파일을 번갈아 나눠 준다. 내려받기·gzip 해제·파싱·조건 검사가 전부 메인 스레드 밖이라 조회 중에도 화면이 멈추지 않는다. 워커 스크립트를 못 읽으면 메인 스레드 경로로 되돌아간다.
- **조건에 맞는 행만 객체로 만든다.** 셀은 문자열 배열로 두고 컬럼 번호로 검사한 뒤, 통과한 행만 화면 모델로 옮긴다.
- **파일 구간이 조회 구간 안에 들어오면 행마다 날짜를 보지 않는다.** 월별 봉인 파일이 구간 끝에 걸릴 때만 행 단위 날짜 검사가 남는다.

1년(1,095개 파일·357,700건) 기준으로 예전 경로는 26.7초가 걸리고 100ms 넘는 프레임 정지가 102번 있었다. 지금은 같은 조건에서 0.7~1.2초이고 100ms를 넘는 프레임이 없다.

표시 한도는 200,000건이다. 넘으면 남은 파일을 읽지 않고 상태줄이 기간을 좁히라고 알린다.

### 나라장터로 바로 열기

사업명을 누르면 뜨는 상세창에는 첨부 목록 위에 나라장터 상세화면 링크(`↗`)가 붙는다. 링크는
공공 API가 필드로 주는 것만 쓴다 — 공고번호로 주소를 조립하지 않는다. 조립하면 나라장터가
주소 체계를 바꿀 때 조용히 깨진 링크가 되는데, 링크가 없는 것보다 나쁘다.

| 모드 | 필드 | 비고 |
| --- | --- | --- |
| 본공고 | `bidNtceDtlUrl` (없으면 `bidNtceUrl`) | 네 개 `*PPSSrch` 오퍼레이션 모두에 있다 |
| 발주계획 | `orderPlanDtlUrl` | |
| 사전공고 | 없음 | 사전규격정보서비스 응답에는 규격문서파일 URL만 있다 |

본공고의 `bidNtceDtlUrl`은 나중에 `shared/service-columns.js`에 추가한 컬럼이라, **그 전에 모아
둔 파일에는 없다.** 옛 파일의 행은 링크 없이 그려지고, 그 구간을 다시 수집하면 채워진다.
`/api/live`가 합친 최신 행은 원본 응답을 그대로 보므로 저장 컬럼과 무관하게 링크가 붙는다.

### 본공고 입찰 일정

본공고 상세창의 `입찰 일정` 탭은 기존 수집 요청인
`getBidPblancListInfo{Cnstwk|Servc|Frgcpt|Thng}PPSSrch` 응답을 그대로 사용한다. 일정 때문에
별도 상세 API를 호출하지 않으므로 모달을 열 때 추가 대기 시간이나 공공 API 호출량이 생기지 않는다.

| 표시 | 공공 API 필드 |
| --- | --- |
| 공고 게시 | `bidNtceDt` |
| 입찰참가자격 등록 마감 | `bidQlfctRgstDt` |
| 공동수급협정 마감 | `cmmnSpldmdAgrmntClseDt` |
| 입찰서 제출 시작 | `bidBeginDt` |
| 입찰서 제출 마감 | `bidClseDt` |
| 개찰 예정 | `opengDt` |

명세상 `opengDt`는 실제 개찰 처리 시각이 아니라 담당자가 개찰을 시작할 수 있는 최초 시각이다.
값이 없는 선택 일정은 목록에서 생략한다. 기존 저장 파일에는 원래 보관하던 공고 게시·입찰 마감만
표시될 수 있고, 새로 수집하거나 실시간 조회한 공고부터 나머지 일정도 함께 표시된다.

## 관심 기관 프리셋

관심 기관은 이름 붙인 세트(프리셋)로 브라우저 `localStorage`에 저장한다. 서버에 두지 않는 이유는 인증이 `GATE_PASSWORD` 하나를 공유하는 방식이라 서버에 저장해도 "누구 것"인지 가릴 수 없기 때문이다.

- 칩을 고치면 **활성 프리셋에 곧바로 저장**된다. 따로 저장 버튼이 없다.
- 셀렉트로 세트를 갈아탄다. 지금 걸린 칩과 부분일치 스위치는 왼쪽 레일에 늘 보이고, 관리 컨트롤(프리셋 셀렉트, 기관 입력)만 `프리셋 열기` 버튼 안에 접혀 있다.
- **브라우저를 벗어나지 않는다.** 다른 기기로 옮기는 경로는 없다 — 내보내기/불러오기 버튼이 있었지만 걷어냈다. 기기마다 따로 만든다.
- 예전 단일 목록(`gong-go:institutions`)은 첫 실행에서 `기본` 프리셋으로 자동 이관된다.
- **고급검색이 기관을 뽑으면 프리셋이 아니라 임시 상태 `(고급검색)`로 들어간다.** 저장하지 않으므로 자연어 질의 한 번에 공들여 만든 세트가 덮이지 않는다.

## 게시일 "오늘" 표시

`index.json` 항목이 `{mode, begin, end, path, count}`이고 일별 파일은 `begin === end === 그 날짜`라, **파일을 하나도 내려받지 않고** 인덱스만으로 오늘 건수를 셀 수 있다. 왼쪽 레일의 공고 유형 세 줄에 각자 오늘 건수가 붙고, 숫자를 누르면 그 모드로 갈아탄 뒤 게시일을 오늘 하루로 좁힌다. 표에서도 오늘 게시된 행에 `오늘` 배지가 붙는다.

"오늘"은 브라우저의 로컬 날짜다. 데이터의 날짜는 타임존 표기가 없는 KST 벽시계 문자열이라 KST 밖에서 열면 하루 어긋난다. 그날 파일이 아직 없으면 0건과 함께 사유를 알린다 — 수집은 KST 09~18시 매시 정각과 매일 05:00에 돈다.

## 고급검색 (자연어 질의)

"국민연금공단의 4월 본공고 알려줘" 같은 문장을 조회 조건으로 바꿔 화면의 컨트롤(모드 토글·게시일·업무구분·검색어·관심 기관)에 그대로 채워 넣고 평소와 똑같이 조회한다. 해석이 틀리면 채워진 값을 손으로 고쳐 다시 검색하면 된다.

**모델은 조건 변환만 한다.** 공고 본문은 모델에 넣지 않는다 — 데이터가 R2의 gzip CSV 수십만 건이라 먹일 수 있는 대상이 아니고, 조회는 기존 워커 스캔이 그대로 맡는다. 결과 재랭킹이나 요약도 하지 않는다.

```text
브라우저 --POST /api/ask--> Worker --Workers AI(JSON schema)--> 조건 JSON --> 화면 컨트롤에 채움 --> 평소 조회
```

### 날짜는 모델이 계산하지 않는다

LLM은 말일·윤년·주 경계에서 틀리는데 형식은 맞아서 정규식 검증을 그대로 통과한다. 그래서 **모델은 `period` enum 하나만 고르고**(`today`·`last_month`·`month`·`explicit` 등) 실제 날짜는 `shared/nl-filter.js`의 `resolvePeriod`가 만든다. "4월"은 `{period:"month", month:4}`로만 받는다.

연도를 말하지 않은 달은 **1일이 오늘 이하인 가장 최근의 그 달**로 본다(오늘이 8월이면 "4월"은 올해 4월, "10월"은 작년 10월). 게시일은 미래가 될 수 없다는 성질이 근거이고, 같은 성질로 구간이 통째로 미래면 연도를 1년 되감는다. 그 뒤 달력 유효성·역전 스왑·`2020-01-01`~오늘 클램프를 한 번 더 건다.

### 기관명은 부분일치로 건다

칩 판정은 원래 정확일치라 CSV가 `국민연금공단 ○○지사`면 "국민연금공단"은 **조용히 0건**이 된다. 그래서 모델이 뽑은 기관에는 `기관명 부분일치` 옵션을 자동으로 켠다(체크박스로 직접 끄고 켤 수도 있다). 실측으로 `경상남도교육청`은 정확일치 1건, 부분일치 28건이다.

두 글자 이하 조건이 하나라도 섞이면 켜지지 않는다 — `공단`으로 부분일치를 걸면 사실상 전체 조회가 된다. 코드를 적어 둔 항목은 부분일치와 무관하게 코드 우선 규칙을 그대로 지킨다.

### 모델과 폴백

`@cf/meta/llama-3.3-70b-instruct-fp8-fast`를 쓴다. JSON schema 모드를 지원하고 한국어 파싱이 8B보다 확실히 낫다. 실패하면 `shared/nl-filter.js`의 **규칙 파서**로 내려가고, 그것도 못 알아들으면 그때만 실패로 알린다. 8B를 중간에 두지 않은 이유는 한국어에서 기관명을 뭉개 조용히 틀린 답을 내기 때문이다.

안전성은 화이트리스트가 맡는다. 사용자 질의는 언제나 user 턴에만 들어가고, 모델 출력은 JSON schema로 강제된 뒤 `normalizeAsk`가 enum·정규식·달력 유효성으로 한 번 더 거른다. 나올 수 있는 최악은 "이상하지만 구조적으로 유효한 조회 조건"이다. 질의는 200자까지만 받는다.

### 바인딩과 비용

시크릿은 늘지 않는다. `wrangler.jsonc`의 바인딩 하나뿐이고 브라우저는 물론 Worker 코드도 키를 만지지 않는다.

```jsonc
"ai": { "binding": "AI", "remote": true }
```

> **Workers AI는 로컬 시뮬레이션이 없다.** `wrangler dev`도 실제 계정으로 프록시하고 **로컬 개발에서도 과금**된다. `--local`로 켜면 `remote: false`와 같아져 오류가 나므로 `npm run worker:dev`에서 `--local`을 뺐다.

`npm run serve`(로컬 devserver)에는 AI 바인딩이 없어 **규칙 파서로만** 답한다. 화면 통합을 로컬에서 개발하기 위한 것이고 해석 정확도는 배포본이 책임진다. 로컬 서버에는 인증이 없어서 AI 호출을 붙이지 않았다 — 아무나 계정 요금을 태울 수 있다.

## 현재 데이터 계약

- 인덱스 항목: `{ mode, begin, end, path, count }`
- 서비스 파일: gzip CSV만 사용
- 파일 경로: 일별 `{pre,bid,plan}/YYYY/MM/DD.csv.gz`, 월별 `{pre,bid,plan}/YYYY/MM.csv.gz`
- 배포 데이터: `index.json`, `analysis-index.json`, 서비스 CSV, 분석 JSON만 공개

과거 평문 CSV나 구 인덱스 형식은 런타임에서 변환하지 않습니다.

## 발주계획의 제약

발주계획(`plan`)은 사전공고·본공고와 같은 화면에서 같은 방식으로 조회되지만, **보유 범위가 소급되지 않습니다.**

발주계획현황 API는 조회 범위 파라미터를 받아 형식까지 검증하면서도(`YYYYMMDD`를 주면 `DATE Format 에러`) 결과를 거르지 않습니다. `orderBgnYm`/`orderEndYm`, `inqryBgnDt`/`inqryEndDt`, `PPSSrch` 변형, `inqryDiv` 1~4를 모두 시험했지만 어떤 범위를 넣어도 같은 응답이 옵니다. 실제로 돌아오는 것은 최근 며칠 안에 게시된 계획뿐입니다.

그래서 수집기는 이 모드를 스냅샷으로 다룹니다. 매 실행이 "지금 열려 있는 창"을 한 번 떠 오고, 게시일시(`nticeDt`)로 일자를 갈라 누적합니다. **과거는 받을 수 없고 수집을 시작한 시점부터 쌓입니다.**

이 성질 때문에 두 곳에 예외가 있습니다. 둘 다 없으면 크론이 돌 때마다 누적분이 사라집니다.

- `collector/collector.js`: `--no-resume`이 수집 구간을 비우는 `clearJobRange`를 스냅샷 모드에서는 건너뜁니다
- `uploader/upload.js`: `vanishedDaily`가 `RANGED_DAILY_KEY`(= `pre`·`bid`만)를 보므로, 로컬에 없는 원격 `plan` 키를 지우지 않습니다
