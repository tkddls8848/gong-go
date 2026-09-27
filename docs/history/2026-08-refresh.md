# 1부. 갱신 성능·안전성 개선 작업 기록

> 당시 조사·결정의 기록입니다. 현재 파일 위치와 작업 기준은 [코드 지도](../code-map.md)를 먼저 확인하세요. 배포 상태·남은 작업·테스트 수치는 작성 당시 기준입니다.

**상태**: 코드 수정·커밋·push 완료 · collect workflow 반영 완료 · **Worker 배포와 재측정은 남음** (2026-08-13 확인)

이 문서는 갱신 경로 조사에서 확인한 문제, 이번에 코드로 고친 것, 아직 운영에서 해야 할 일을
한곳에 기록한다. 조사 당시 기준 커밋은 `c544213`, 기준 실행은 GitHub Actions run `31491773531`이다.

조사 이후 `352bb59`(사이트 최적화) → `6b8cb60`(문서) → `45287a6`(끊긴 요청 재시도)이 더 들어왔다.
`dev`와 `origin/dev`는 같고 작업 트리는 깨끗하다.

**배포본이 코드보다 뒤처져 있다.** 마지막 Worker 배포는 `2026-08-11T12:31Z`(KST 21:31)인데
`352bb59`는 그보다 뒤인 KST 22:48에 커밋됐다. 즉 운영에는 `352bb59`가 바꾼 `src/worker.js`와
`public/`이 아직 올라가 있지 않다. `72ebc19`의 워커 스캔(`public/search-worker.js`)은 KST 19:39
커밋이라 배포에 포함돼 있다. 배포 이력은 `npx wrangler deployments list`로 확인한다.

---

## 1. 수정 전 기준선

| 구간 | 실측 |
|---|---:|
| 갱신 버튼 → workflow 완료 | 111초 |
| 러너 준비 | 18.1초 |
| 수집 | 80.6초 |
| 업로드 | 7.9초 |
| 마무리 | 4.4초 |
| 정상 실행의 전체 HTTP 요청 | 약 45~47회 |
| 최근 일별 CSV 브라우저 캐시 | 최대 300초 |

111초는 현행 구성의 성공 표본 한 건이다. 장기 중앙값으로 사용하지 않는다. 수집이 80.6초로 가장
길지만 요청별 시간이 없었기 때문에 국내 러너, 페이지 크기, 동시성 중 무엇이 유효한지는 판단할 수
없었다. 화면에서는 workflow가 끝나도 같은 CSV URL의 fresh 캐시를 다시 사용해 새 행 반영이 더
늦어질 수 있었다.

## 2. 이번에 완료한 것

### 2.1. 갱신 뒤 브라우저 캐시 재검증

- `public/app.js`가 갱신 완료 직후 현재 조회 대상으로 선택된 최근 일별 CSV에 한해
  `cache: "no-cache"`를 사용한다.
- URL에 캐시버스트 쿼리를 붙이지 않는다. 기존 ETag를 이용해 바뀌지 않은 파일은 304로 처리한다.
- 브라우저를 닫았다가 다시 열어도 `index.updatedAt`이 이전 값과 달라졌으면 첫 조회에서 같은
  재검증을 수행한다.
- workflow 시작 뒤 60초까지는 5초, 그 이후에는 2초 간격으로 상태를 확인한다.

관련 파일: `public/app.js`, `public/search-worker.js`, `public/rows.js`

### 2.2. CSV 바이트 결정성 확보

- `collector/collector.js`가 CSV를 쓰기 전에 행을 공고 키로 정렬한다.
- HTTP 작업 완료 순서가 달라도 같은 데이터는 같은 행 순서와 같은 gzip 바이트를 만든다.
- 업로더의 MD5/ETag 비교가 순서 변화만으로 파일을 변경으로 판정하던 원인을 제거했다.

### 2.3. 요청별 계측 추가

- collector가 각 attempt마다 다음 JSON 로그를 남긴다.

```json
{
  "mode": "bid",
  "type": "물품",
  "range": "2026-07-07~2026-08-03",
  "page": 1,
  "queueWaitMs": 0.2,
  "fetchMs": 1840.3,
  "status": 200,
  "bytes": 123456,
  "retry": 0,
  "upstreamMs": 510.4
}
```

- URL에는 `ServiceKey`가 있으므로 로그에 URL을 남기지 않는다. `mode/type/range/page`만 남긴다.
- Worker 중계는 `Server-Timing: upstream;dur=...`를 반환하고 collector가 이를 `upstreamMs`로
  기록한다.
- collector의 `fetchMs`는 응답 본문을 모두 읽는 시간까지 포함한다. `upstreamMs`는 Worker가
  상류 응답을 받기까지의 시간이다. 두 값을 같은 구간으로 간주해 단순 차감하지 않는다.

관련 파일: `collector/collector.js`, `src/worker.js`

### 2.4. 재시도와 timeout 보강

- 각 요청 attempt에 90초 timeout을 적용했다. 이 시한은 본문을 다 받는 시간까지 포함한다.
  본공고 한 페이지가 5~6MB라 동시 8요청에서는 정상 응답도 15~30초가 걸린다.
- 재시도 여부는 응답 상태가 아니라 오류에 달린 `httpStatus`로 가린다. 상태로 가리면 본문을
  받다 끊긴 요청이 재시도에서 빠진다 — 그때는 헤더에서 읽은 200이 이미 기록돼 있다.
- 408, 429, 5xx는 재시도한다. 인증 오류 같은 다른 4xx는 즉시 실패한다. 상태까지 가지 못했거나
  본문에서 끊긴 실패(네트워크 오류, timeout, 잘린 JSON)는 모두 재시도한다.
- 재시도 대기에는 exponential backoff와 jitter를 적용한다.
- 상류의 `Retry-After`가 있으면 Worker가 전달하고 collector가 그 시간보다 빨리 재시도하지 않는다.
- backoff 중에는 HTTP 동시성 permit을 반환한다. 실패한 한 요청이 잠든 동안 다른 첫 요청을
  막지 않는다.

### 2.5. `--no-resume` 행 제거와 저장 겹치기 수정

- 새 raw 레코드에 ServiceKey와 쿼리를 제외한 `__sourceEndpoint`를 저장한다.
- `--no-resume` 재수집 시 `bsnsDivNm`이 아니라 원천 endpoint를 기준으로 기존 행을 제거한다.
- endpoint 표식이 없던 과거 본공고는 같은 모드·범위의 네 업무 endpoint가 모두 성공한 경우에만
  정리한다. 일부 endpoint가 실패하면 기존 행을 보존한다.
- `--no-resume`에서도 8개 작업마다 중간 저장을 시작해 gzip·파일 쓰기와 남은 HTTP 요청을
  겹친다.

### 2.6. 업로더를 fail-safe 기본값으로 전환

- `node uploader/upload.js`와 `npm run upload`는 이제 항상 dry-run이다.
- 실제 R2 PUT/DELETE는 정확한 `--commit`이 있을 때만 수행한다.
- 알 수 없는 인자와 `--dry-run --commit` 동시 사용은 오류로 끝낸다.
- 실제 실행은 npm의 인자 전달을 거치지 않고 아래처럼 직접 호출한다.

```powershell
node uploader/upload.js --commit
```

GitHub Actions도 같은 명령을 명시적으로 사용한다. 조사 중처럼 npm이 `--dry-run`을 삼켜 실제
삭제 경로로 들어가는 사고는 기본값 단계에서 차단된다.

관련 파일: `uploader/upload.js`, `.github/workflows/collect.yml`, `README.md`

### 2.7. 러너 준비 경로 수정

- Actions의 Node 버전을 20에서 러너 tool cache에 있는 22로 변경했다.
- dev 패키지 tarball이 포함된 기존 setup-node npm 캐시를 복원하지 않는다.
- 외부 패키지를 쓰지 않는 collector를 먼저 실행하고, 성공 확인 뒤 uploader 직전에
  `npm ci --omit=dev`를 실행한다.
- 기본 수집 범위의 의미를 “오늘과 이전 35일”, 양끝 포함 36개 날짜로 문서와 workflow 입력
  설명에 명시했다.

### 2.8. 조회 스캔을 워커로 내림 (`72ebc19`)

갱신이 아니라 **조회** 쪽 변경이라 위 항목들과 축이 다르지만, 같은 작업 구간에서 끝났고 이 문서에
기록이 빠져 있었다. 조회는 인덱스에서 고른 `.csv.gz`를 브라우저가 직접 받아 훑는 방식이라 구간이
길어지면 파일 수가 그대로 일거리가 된다. 네 가지로 줄였다.

- **모드별로만 받는다.** 인덱스 항목의 `mode`가 화면 토글과 같은 것만 고른다(`public/app.js:121-125`).
  날짜만 보고 고르면 사전공고를 보는데 본공고·발주계획까지 받아 풀고 파싱한 뒤 버린다.
- **스캔은 워커에서 돈다.** `public/search-worker.js`를 코어 수에 맞춰 최대 3~4개 띄우고
  (`POOL_SIZE`, `public/app.js:5`) 파일을 번갈아 나눠 준다(`public/app.js:177`). 내려받기·gzip
  해제·파싱·조건 검사가 전부 메인 스레드 밖이다. 워커 스크립트를 못 읽으면 메인 스레드 경로로
  되돌아간다(`public/app.js:174`의 `fallback` → `scanInline`).
- **조건에 맞는 행만 객체로 만든다.** 셀은 문자열 배열로 두고 컬럼 번호로 검사한 뒤
  (`public/rows.js:126-136`의 `accepts`), 통과한 행만 화면 모델로 옮긴다(`buildRow`).
- **파일 구간이 조회 구간 안에 들어오면 행마다 날짜를 보지 않는다**(`public/search-worker.js:36`).
  월별 봉인 파일이 구간 끝에 걸릴 때만 행 단위 날짜 검사가 남는다.

1년(1,095개 파일·357,700건) 기준으로 예전 경로는 26.7초가 걸렸고 100ms 넘는 프레임 정지가 102번
있었다. 같은 조건에서 0.7~1.2초이고 100ms를 넘는 프레임이 없다. 표시 한도는 `MAX_ROWS = 200000`
이고(`public/app.js:2`), 넘으면 남은 파일을 읽지 않고 상태줄이 기간을 좁히라고 알린다. 결과가
쌓이는 동안 첫 페이지를 미리 그리되 `PREVIEW_LIMIT`(30,000건)을 넘으면 진행률만 갱신한다
(`public/app.js:8`).

관련 파일: `public/app.js`, `public/search-worker.js`, `public/rows.js`, `test/rows.test.js`

## 3. 완료한 검증

| 검증 | 결과 |
|---|---|
| `npm test` | 47/47 통과 |
| 수정한 JavaScript `node --check` | 통과 |
| `git diff --check` | 통과 |
| `wrangler deploy --dry-run` | 번들링 성공 |
| `data/` 변경 | 없음 |
| 운영 R2 PUT/DELETE | 실행하지 않음 |
| GitHub Actions dispatch | 실행하지 않음 |

추가된 테스트는 행 정렬 결정성, 원천 endpoint 보존과 안전한 legacy 이관, Server-Timing 파싱,
재시도 상태 분류, 업로더 기본 dry-run, 브라우저 fetch 옵션 전달을 확인한다.

## 4. 아직 하지 않은 것

### 4.1. 그 뒤로 확인된 것 (2026-08-13)

- **커밋과 push는 끝났다.** `dev`가 `origin/dev`와 같고 작업 트리가 깨끗하다.
- **collect workflow가 운영에서 돌고 있다.** 최근 5회가 모두 성공했고 그중 하나는 크론 실행이다
  (`31639727243`, 2026-08-12T20:51Z = KST 05:51). 수동 실행 `31709093885`(2026-08-13T14:14Z)도
  성공했다. 조사 중 되감겼던 R2는 이 실행들로 복구됐다.
  ```powershell
  gh run list --repo tkddls8848/gong-go --workflow collect.yml --limit 5
  ```

### 4.2. 남은 것

다음 항목은 코드만으로 완료 판정할 수 없거나, 계측 결과를 먼저 봐야 하므로 남겨 두었다.

- **Worker를 최신 코드로 배포하지 않았다.** 배포 자체는 있었지만 마지막 배포가
  `2026-08-11T12:31Z`라 그 뒤 커밋 `352bb59`의 `src/worker.js`·`public/` 변경이 운영에 없다.
  다음 배포 때 함께 올라간다.
- 수정 후 같은 범위를 연속 두 번 수집해 두 번째 실행의 데이터 PUT 수를 확인하지 않았다.
- workflow 전체 소요는 이제 볼 수 있지만(위 5회에서 1m46s~4m2s) **단계별 분해는 읽지 않았다.**
  기준선 111초와 비교하려면 러너 준비·수집·업로드 구간을 각각 봐야 한다. 따라서 §2.7의 Node 22와
  npm 캐시 제거가 러너 준비를 실제로 얼마나 줄였는지는 아직 모른다. 전체 시간만으로 판단하지 않는다.
- 페이지별 latency/bytes 분포를 아직 얻지 않았다. 계측 코드만 추가된 상태다.
- `numOfRows`를 999보다 늘리지 않았다.
- `concurrency`를 8보다 늘리지 않았다.
- 국내 러너 또는 별도 VM으로 옮기지 않았다.
- Cloudflare 대시보드의 Cache Rule/Browser TTL override는 확인하지 못했다.
- 나라장터의 최대 `numOfRows`, 28일 초과 범위 완전성, 429 정책은 확인하지 않았다.

## 5. 운영 반영 순서

순서를 바꾸지 않는다. Worker와 Actions 코드가 함께 바뀌므로 반쪽만 반영하면 계측이 빠지거나
구 워크플로가 안전장치 없는 업로더를 실행할 수 있다.

1. ~~변경 diff와 테스트 결과를 검토하고 한 커밋으로 만든다.~~ **완료**
2. ~~`dev`에 push해 collect workflow가 Node 22와 `--commit` 명령을 사용하게 한다.~~ **완료**
3. Worker를 배포한다. 이 단계에서 브라우저 재검증 코드와 `Server-Timing`이 운영에 들어간다.
   **아직이다** — 마지막 배포가 `352bb59`보다 앞선다(§4.2).
4. ~~collect workflow를 한 번 수동 실행한다. 이것이 조사 중 되감긴 최근 35일 데이터를 복구한다.~~
   **완료** — 수동·크론 실행 모두 성공했다(§4.1).
5. workflow 성공은 확인했다. **`sync-errors.json` 0건과 R2 `index.json.updatedAt` 갱신은 아직
   확인하지 않았다.**
6. 브라우저에서 갱신 완료 직후 현재 결과가 다시 조회되는지 확인한다. 3번 배포 뒤에 한다.
7. 동일한 begin/end로 한 번 더 실행해 안정 정렬 뒤 불필요한 데이터 PUT 수를 측정한다.

운영 반영 전에 다시 실행할 안전 검증:

```powershell
npm test
npx wrangler deploy --dry-run
npm run upload
```

마지막 `npm run upload`는 dry-run이다. 출력의 업로드·삭제 예정 수가 예상과 다르면
`--commit`을 실행하지 않는다.

## 6. 운영 확인 기준

### 6.1. R2 복구

- collect workflow가 성공한다.
- `data/sync-errors.json`의 배열 길이가 0이다.
- R2의 `index.json.updatedAt`이 복구 실행 시각으로 바뀐다.
- 2026-08-11 정상 실행 직전과 비교해 최근 35일의 파일과 행이 다시 들어온다.
- 버킷의 과거 월별 봉인 파일이 유지된다.

### 6.2. 브라우저 캐시

- 갱신 완료 뒤 별도 검색 버튼 조작 없이 현재 결과 조회가 다시 실행된다.
- 최근 CSV 요청은 같은 URL을 사용한다.
- 바뀌지 않은 파일은 가능한 경우 304, 바뀐 파일은 200으로 최신 본문을 받는다.
- 갱신 뒤 새 행이 300초 TTL 만료를 기다리지 않고 화면에 나타난다.

### 6.3. 결정적 CSV와 업로드

- 같은 begin/end를 연속 실행했을 때 두 번째 실행의 데이터 PUT가 첫 실행보다 크게 줄어야 한다.
- 두 실행 사이 실제 공고 변경이 없으면 두 번째 PUT는 0에 가까워야 한다.
- PUT가 계속 많으면 변경된 파일 하나를 골라 raw CSV의 행 순서가 아니라 컬럼 순서나 실제 값이
  달라졌는지 비교한다.

### 6.4. 요청 latency

한 번의 정상 실행 로그에서 다음을 집계한다.

| 지표 | 판단에 쓰는 곳 |
|---|---|
| `fetchMs` 중앙값, p90, 최대 | 요청 자체가 느린지 확인 |
| `queueWaitMs` 중앙값, p90, 최대 | 동시성 8이 실제 병목인지 확인 |
| `upstreamMs`와 `fetchMs` 분포 | Worker 상류 구간과 전체 수신 시간 비교 |
| mode/type별 페이지 수와 bytes | `numOfRows` 확대 후보 선정 |
| status와 retry 횟수 | 429/5xx 및 재시도 정책 확인 |

판정 원칙:

- `queueWaitMs`가 작고 `fetchMs`가 크면 동시성을 먼저 올리지 않는다.
- 페이지마다 고정 지연이 크고 응답 bytes가 작으면 `numOfRows` 확대 A/B를 검토한다.
- `upstreamMs`가 대부분을 차지하면 collector 실행 지역보다 Worker→나라장터 구간이 우선이다.
- Worker 밖의 시간이 크고 지역별 차이가 확인되면 그때 국내 러너/VM을 검토한다.
- 429 또는 5xx가 생기면 동시성과 페이지 크기를 높이지 않는다.

## 7. 다음 결정

운영 반영 직후에는 최적화 값을 더 바꾸지 않는다. 먼저 수정된 구성으로 두 번 측정한다.

1. 첫 실행: R2 복구와 새 계측 수집.
2. 같은 범위의 두 번째 실행: CSV 결정성과 불필요한 PUT 제거 확인.
3. 두 실행의 로그를 기준으로 `numOfRows`, `concurrency`, 러너 위치 중 하나만 선택해 A/B한다.

절감치는 서로 겹치므로 여러 값을 동시에 바꾸거나 추정 절감치를 합산하지 않는다.

---
