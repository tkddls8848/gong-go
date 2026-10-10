# 설치와 운영

현재 코드 위치는 [코드 지도](code-map.md)를 참고합니다.

## 준비

Node.js 22.7 이상에서 설치하고 `.env.example`을 `.env`로 복사해 필요한 값을 채웁니다.

```powershell
npm ci
```

주요 환경변수는 다음과 같습니다. 전체 목록과 설명은 `.env.example`을 기준으로 합니다.

- `DATA_GO_KR_SERVICE_KEY`: 공공데이터포털 일반 인증키(포털이 발급한 키 그대로. 인코딩·디코딩 구분 없음)
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: R2 업로드(uploader/, collector/restore-r2.js)
- `R2_ENDPOINT`: 선택. 설정하면 `R2_ACCOUNT_ID` 대신 이 전체 주소로 R2에 접속
- `ANTHROPIC_API_KEY`: Anthropic 분석을 사용할 때만 필요
- `API_BASE`, `RELAY_TOKEN`: 공공데이터 API 중계 경유 설정. 로컬에서는 비워 둡니다([공공데이터 API 중계](#공공데이터-api-중계) 참고)

다음 값은 Worker만 읽으므로 `.env`에 두지 않습니다. `npx wrangler secret put <이름>`으로 Cloudflare에만
등록하고 원본 값은 비밀번호 관리자에 보관합니다. `.env`에 사본을 두면 운영 값과 어긋나도 알아채지 못합니다.

- `GATE_PASSWORD`: Worker 조회 화면 비밀번호
- `AI_ANALYSIS_PASSWORD`: AI 분석 전용 암호(16자 이상, 조회 암호와 다르게). 미설정 시 ECR 분석과 자연어 검색의 AI 호출이 잠김
- `GITHUB_PAT_TOKEN`: 배포 화면의 갱신 버튼과 매시 cron이 collect.yml을 걸 때 쓰는 GitHub fine-grained PAT. 이 저장소의 Actions read/write 권한만 부여

## 운영 실행

조회 화면은 Cloudflare Worker 배포 주소에서만 사용한다. 로컬 웹 서버는 제공하지 않는다.
수집은 GitHub Actions와 운영 화면의 갱신 버튼으로 실행한다.

```powershell
npm test
npm run deploy
```

## 공공데이터 API 중계

GitHub Actions 러너에서는 `apis.data.go.kr:443`으로 TCP 연결이 성립하지 않습니다. 거부가 아니라 타임아웃이고, 같은 코드가 국내에서는 33ms 만에 붙습니다. 차단 기준은 국가가 아니라 **IP 대역**입니다 — Cloudflare 엣지에서는 미국 LAX colo에서도 155~515ms로 응답이 옵니다. 그래서 러너의 수집 요청만 Worker가 대신 내보냅니다.

```text
수집기(러너) --Bearer RELAY_TOKEN--> Worker /api/relay --> apis.data.go.kr
```

`API_BASE`가 비어 있으면 수집기는 `apis.data.go.kr`을 직접 부릅니다. 국내 로컬은 설정할 필요가 없고, 러너에서만 중계를 탑니다.

중계는 두 가지로 제한됩니다.

- **경로 화이트리스트**: `src/relay.js`의 `RELAY_ALLOW`에 적힌 세 서비스만 통과합니다. 임의 URL을 받아 주면 이 Worker가 공개 프록시가 됩니다.
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
npx wrangler secret put AI_ANALYSIS_PASSWORD
npx wrangler secret put GITHUB_PAT_TOKEN
npx wrangler secret put RELAY_TOKEN     # 이름이 정확해야 한다 — 아래 주의 참고
npx wrangler secret put DATA_GO_KR_SERVICE_KEY  # 저장 결과 위에 최신 공고를 합치는 /api/live용
npm run deploy
```

수집기가 만드는 `data/raw/{pre,bid,plan}/YYYY/MM/DD.csv.gz`도 같은 구조의
`raw/{pre,bid,plan}/YYYY/MM/DD.csv.gz` R2 객체로 업로드한다. Worker의 공개 데이터 경로에는
raw 프리픽스를 허용하지 않으므로 사이트 방문자가 원본 백업을 직접 내려받지는 못한다.
명시한 재수집 구간에서 공고가 사라지면 서비스 일별 파일과 대응 raw 객체를 함께 정리한다.

과거 raw를 채우거나 새 컬럼을 소급할 때는 GitHub Actions의 `historical-backfill`을 실행한다. 기본 범위는
`2020-01-01 ~ KST 오늘`이며 3개월씩 순차 처리한다. 과거 조회가 가능한 사전공고와 본공고를
다시 받아 전체 컬럼 raw 일별 CSV와 서비스 CSV를 같은 기간 전체에 대해 R2에 저장한다.
개별 백필 작업은 `--put-only` 업로드라 운영 `index.json`과 원격 삭제를 건드리지 않는다.
모든 작업이 성공한 뒤에만 최종 작업이 `index.json.schemaVersion`을 올린다. 화면은 이 값을
CSV URL에 붙여 기존 1년 immutable 캐시를 새 데이터로 한 번 교체한다. 발주계획 API는 과거
범위 조회를 지원하지 않아 역사 백필 대상에서 제외된다.

### 보존 구간 — 서비스와 raw 모두 2020년부터 전부

서비스 데이터와 raw 원본 모두 **2020-01-01부터 현재까지 누적 보관**한다.
12개월 제한, 기간 만료 삭제, 매일 04시 저장용량 정리 크론은 사용하지 않는다.
기존 매시/매일 수집은 유지하여 새 서비스 데이터와 raw를 계속 갱신한다.

| 대상 | R2 키 | 보존 |
| --- | --- | --- |
| 서비스 CSV | `{pre,bid,plan}/YYYY/MM[/DD].csv.gz` | 2020년부터 누적 |
| raw 원본 | `raw/{pre,bid,plan}/YYYY/MM/DD.csv.gz` | 2020년부터 누적 |

raw에서 서비스 데이터를 복원할 때는 `node collector/restore-r2.js`로 대상을 확인하고,
`node collector/restore-r2.js --commit`으로 실행한다. raw는 읽기만 하며 서비스 컬럼을
복원하고 행 수를 확인한 뒤 파일을 올린다. 모든 파일이 성공하면 인덱스를 갱신한다.
`node uploader/storage-report.js`는 용량을 읽기만 하는 수동 점검 도구다.

`node uploader/verify-history.js`는 **위 보존 방침이 실제로 지켜지는지 검사하는** 읽기 전용
점검 도구다. raw 일자마다 대응하는 서비스 CSV(일별 또는 월별)가 있고 그 파일이 인덱스에도
올라와 있는지 확인한 뒤, 원본 개수·바이트와 서비스 파일 수·행 수·기간을 JSON으로 출력한다.
연결이 끊긴 키는 `missing`에 모인다. `missing`이 있거나 서비스 시작일이 2020-01-01이 아니면
종료 코드 1을 반환한다 — 이 날짜는 위 보존 방침을 그대로 옮겨 적은 것이므로, 방침을 바꾸면
이 상수도 함께 고쳐야 한다. `R2_ACCESS_KEY_ID`·`R2_SECRET_ACCESS_KEY`와 `R2_ENDPOINT`
(또는 `R2_ACCOUNT_ID`)가 필요하다. 쓰기와 삭제는 하지 않으므로 운영 중에 돌려도 안전하다.

발주계획 API는 과거 소급 조회를 지원하지 않으므로 확보한 스냅샷부터 보존한다.
원본의 정정·이동에 따른 중복 정리와 수동 월별 봉인은 데이터 동기화 기능으로 유지한다.
데이터가 오래됐다는 이유로 삭제하지 않는다.

> 시크릿 이름은 코드가 읽는 것과 **정확히** 같아야 합니다. Worker는 `env.RELAY_TOKEN`을
> 읽으므로 `RELAY` 같은 다른 이름으로 등록하면 값이 들어 있어도 중계가 501을 반환합니다.
> 시크릿은 비대화형 셸에서 등록하지 마세요(아래 [토큰 등록](#토큰-등록) 경고 참고).

Cloudflare 기본 기능 시크릿은 `GATE_PASSWORD`, `GITHUB_PAT_TOKEN`, `RELAY_TOKEN`, `DATA_GO_KR_SERVICE_KEY`이며, AI 분석에는 별도로 `AI_ANALYSIS_PASSWORD`가 필요합니다. `GITHUB_PAT_TOKEN`이 없으면 배포 화면의 갱신 API가, `RELAY_TOKEN`이 없으면 수집 중계가, `DATA_GO_KR_SERVICE_KEY`가 없으면 최신 공고 합치기가 501을 반환합니다. GitHub 저장소에도 Actions용 `DATA_GO_KR_SERVICE_KEY`, `API_BASE`, `RELAY_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`를 등록해야 합니다.

배포 승인, 검증 근거, 장애 대응 및 되돌리기 순서는 [출시 체크리스트](release-checklist.md)를 따릅니다. 로컬 테스트 통과만으로 운영 검증 완료라고 판단하지 않습니다.

수집은 `.github/workflows/collect.yml` 하나가 다 하고, 그것을 **거는 경로가 셋**입니다.

| 거는 쪽 | 시각 | GitHub 이벤트 | 수집 범위 |
| --- | --- | --- | --- |
| Worker Cron Trigger (`wrangler.jsonc`의 `triggers.crons` → `src/worker.js`의 `scheduled`) | `0 0-9 * * *` UTC = KST 09~18시 정각, 하루 10회 | `workflow_dispatch` | 어제~오늘 |
| GitHub `schedule` | `0 20 * * *` UTC = KST 05:00 | `schedule` | 오늘과 이전 35일 |
| 배포 화면의 갱신 버튼 | 누를 때 | `workflow_dispatch` | 어제~오늘 (매시 크론과 같음) |
| GitHub에서 수동 실행 | 누를 때 | `workflow_dispatch` | 입력값, 비우면 오늘과 이전 35일 |

**매시 갱신을 Worker가 거는 이유**는 GitHub의 `schedule`이 최선 노력이라 혼잡 시간대에 수십 분씩 밀리기 때문입니다. 그 지연 위에서는 "당일 공고를 한 시간 안에"가 성립하지 않습니다. Cloudflare Cron Trigger는 예정 시각에 거의 그대로 뜨므로 트리거만 그쪽으로 옮겼고, 수집 자체는 그대로 GitHub 러너에서 돕니다. 다만 정시성은 **트리거 시각**의 정시성입니다 — 러너 준비와 수집에 다시 1~2분이 걸리므로 R2 반영은 그만큼 뒤입니다.

**크론과 갱신 버튼이 같은 `workflow_dispatch`를 씁니다.** 둘을 갈라 주는 `repository_dispatch`를 먼저 썼다가 되돌렸습니다 — 그쪽은 `workflow_dispatch`(Actions 쓰기)와 달리 저장소 **Contents 쓰기**를 요구하는데, `GITHUB_PAT_TOKEN`은 Actions read/write만 가지고 있어 403이 납니다. 토큰을 넓히는 것보다 같은 문을 쓰는 편이 낫다고 봤습니다.

같은 문을 써도 버튼이 크론 실행의 결과를 제 것으로 보고하지는 않습니다. 다만 그 근거는 실행 id가 **아닙니다** — `workflow_dispatch`는 204 No Content라 id를 주지 않습니다. 대신 버튼은 dispatch 시각을 받아 `?since=`로 묻고, Worker는 `created>=`를 붙여 그 뒤에 만들어진 실행만 봅니다. GitHub이 실행을 아직 만들지 않았으면 "없음"이 아니라 대기로 답합니다 — 여기서 완료로 답하면 방금 건 갱신이 시작도 전에 끝난 것으로 보입니다. 실행 id가 조회에 처음 잡히는 순간 화면이 거기에 고정하므로(`?runId=`), 폴링 도중 매시 크론이 새 실행을 걸어도 추적 대상이 갈아타지 않습니다. 2분이 넘도록 실행이 등록되지 않으면 폴링을 끊고 Actions 탭을 확인하라고 알립니다.

`since` 없이 최근 `workflow_dispatch` 실행 하나를 보는 경로(`handleRefresh`의 `runId`·`since` 없는 분기)로 내려가는 것은 갱신 중에 페이지를 새로 열어 `resumeRefresh`가 상태를 되찾을 때뿐입니다. 그때는 크론 실행을 보고 진행/완료를 표시할 수 있는데, 수집 자체는 정상이고 표시만 어긋납니다.

**범위를 나눈 이유**는 비용입니다. 본공고 한 페이지가 5~6MB라 매시 36일치를 다시 훑으면 하루에 수 GB를 나라장터에서 되받습니다. 매시 범위를 오늘 하루가 아니라 **어제~오늘**로 잡은 것은, 전날 18시 실행 뒤에 등록된 공고가 어제 날짜로 남아 다음 날 05:00까지 들어오지 못하기 때문입니다. 이틀은 28일 청크 하나에 들어가므로 작업 수는 그대로이고 페이지 수만 늡니다.

`wrangler.jsonc`의 크론 식은 **UTC로만** 해석됩니다(KST 표기가 없습니다). 크론 트리거는 `npm run deploy`로 배포해야 등록됩니다. 실행 결과는 Cloudflare 로그와 GitHub Actions에서 확인합니다.

### 갱신에 걸리는 시간

2026-08-11의 수동 실행 한 건(run `31491773531`)에서는 버튼부터 완료까지 111초가 걸렸습니다. 러너 준비 18.1초, 수집 80.6초, 업로드 7.9초, 마무리 4.4초였습니다. 현재 구성의 성공 표본이 한 건뿐이므로 111초를 장기 중앙값으로 보지는 마세요.

- **러너 준비**: `npm ci --omit=dev` 자체는 위 실행에서 1.45초였습니다. 더 큰 비용이던 Node 20 다운로드와 72MB의 오래된 npm 캐시 복원을 피하도록, 워크플로는 러너 tool cache에 있는 Node 22를 쓰고 의존성은 수집 뒤 uploader 직전에 설치합니다.
- **수집 루프**: 정상 실행의 전체 요청은 약 45~47회뿐이고, 위 실행에서는 동시 요청 8개로도 수집에 80.6초가 걸렸습니다. 요청 수보다 요청별 지연을 먼저 봐야 합니다. 로그의 `HTTP` JSON에는 ServiceKey가 든 URL 대신 `mode/type/range/page`, `queueWaitMs`, `fetchMs`, `status`, `bytes`, `retry`, Worker가 돌려준 `upstreamMs`만 남습니다.
- **동시 요청 수와 페이지 크기**: 요청별 계측 없이 `concurrency`나 `numOfRows`부터 올리지 마세요. 상대 서버 부하와 429 위험이 함께 커집니다. 한 번 실행한 뒤 `queueWaitMs`와 `fetchMs` 분포를 보고 결정하고, 변경할 때는 한 단계씩 적용한 뒤 `data/sync-errors.json`을 확인하세요.
- **브라우저 반영**: 최근 일별 CSV는 최대 300초 캐시되지만, 갱신 완료 직후 현재 선택된 최근 파일은 `cache: "no-cache"`로 한 번 조건부 재검증합니다. URL을 바꾸지 않으므로 바뀌지 않은 파일은 ETag로 304 응답을 받고 기존 캐시를 계속 씁니다.
- **완료 감지**: 화면은 진행 상태를 폴링합니다. 시작 60초 안쪽이면 2초, 넘어가면 5초 간격입니다(`public/refresh.js`의 `pollDelay`). 버튼 실행이 30초대에 끝나므로 촘촘한 쪽이 기본이고, 60초를 넘기는 것은 35일 재수집이거나 큐에 걸린 쪽이라 그때만 느슨해집니다. 예전에는 이 조건이 뒤집혀 있어 버튼 경로가 언제나 5초 간격만 썼고, 이미 끝난 실행을 최대 5초 늦게 알아챘습니다.
- **큐 대기**: `collect.yml`의 `concurrency`(`group: collect`, `cancel-in-progress: false`)가 실행을 직렬화합니다. 앞 실행이 도는 동안 건 dispatch는 러너조차 잡지 못하고 기다립니다 — 09시 정각 크론과 겹친 버튼이 큐에서만 **85초**를 썼습니다(run `32709162111`: run created 09:00:11, job created 09:01:36, 총 2분 3초). 아래 "이미 도는 실행에 붙는다"가 이 구간을 없앱니다.

위 111초는 **오늘과 이전 35일**(양끝 포함 36개 날짜)을 받은 실행입니다. 지금 이 범위로 도는 것은 새벽 크론뿐이고, 매시 크론과 갱신 버튼은 어제~오늘만 받습니다 — 2026-08-14의 실측으로 12개 작업·2,489건에 **26초**였습니다. 넓은 범위를 없애지 않는 이유는 나라장터가 지난 공고를 소급 수정하기 때문입니다. 어제 하루만 받으면 그 사이 바뀐 건을 놓치므로, 소급분은 새벽 실행이 따로 훑습니다.

갱신 버튼으로는 이제 35일 전체를 다시 받을 수 없습니다. 필요하면 GitHub Actions에서 `collect`를 입력값 없이 수동 실행하세요.

### 이미 도는 실행에 붙는다

버튼을 눌렀을 때 끝나지 않은 `collect` 실행이 있으면, Worker는 **새로 걸지 않고 그 실행에 붙습니다** — 응답이 `409`이고 본문에 그 실행의 `runId`가 실립니다. 화면은 409를 오류로 보지 않고 그 id로 폴링을 이어 갑니다.

근거는 두 가지입니다. 하나는 위의 큐 대기 — 어차피 앞 실행이 끝나야 시작하므로 새 실행을 걸어 봐야 기다리는 시간만 늘어납니다. 다른 하나는 범위 — 매시 크론과 버튼은 같은 어제~오늘을 받으므로 돌고 있는 그 실행이 곧 버튼이 원하는 결과입니다.

찾을 때 **이벤트를 가리지 않습니다.** concurrency group은 이벤트와 무관하게 하나로 묶이므로 새벽 `schedule` 실행(35일 재수집)도 버튼을 줄 세웁니다. 상태 조회 쪽이 `event=workflow_dispatch`로 거르는 것과 목적이 다릅니다 — 거기서는 "내가 건 실행"을 집어야 하고, 여기서는 "나를 막을 실행"을 찾습니다.

붙을 때는 **범위를 싣지 않습니다.** 실행 정보는 `workflow_dispatch`의 `inputs`를 되돌려주지 않아 그 실행이 어느 구간을 받는 중인지 알 수 없습니다. 그래서 진행·완료 문구의 구간이 그때만 `-`로 남습니다 — 지어내는 것보다 낫다고 봤습니다.

붙는 것은 나라장터 API를 한 번도 더 부르지 않으므로 **하루 한도와 쿨다운을 세지 않습니다.** 다만 그 둘은 이 조회보다 **먼저** 봅니다. 한도를 넘긴 요청은 GitHub에 아무것도 묻지 않는다는 성질을 그대로 두기 위해서입니다. 조회 자체가 실패하면 막지 않고 예전처럼 그냥 dispatch합니다 — 최악이라도 지금까지처럼 큐에서 기다릴 뿐입니다.
