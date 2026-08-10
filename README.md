# 나라장터 공고·ECR 조회

나라장터 사전공고·본공고·발주계획을 수집해 검색하고, 본공고 첨부 문서에서 ECR 규격을 추출하는 개인용 서비스입니다. 운영 경로는 Cloudflare Worker + R2이며, 매일 GitHub Actions가 최근 35일을 다시 수집합니다.

## 구성

- `collector/`: 공공데이터 API 수집, 일별 gzip CSV 저장, 지난 월 봉인
- `downloader/` → `converter/` → `analyzer/`: 첨부 다운로드, HWPX/Markdown 변환, ECR 분석
- `uploader/`: 변경된 데이터만 R2 업로드
- `public/`: 조회 화면
- `src/worker.js`: 비밀번호 인증, 정적 자산/R2 제공, 원격 갱신 실행, 공공데이터 API 중계
- `shared/`: CSV와 파이프라인 공용 함수

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
gh secret set API_BASE --repo tkddls8848/gong-go --body "https://gong-go-dev.<계정>.workers.dev/api/relay"
```

`API_BASE`를 비워 두면 러너가 직접 호출로 되돌아가 다시 타임아웃납니다.

### 확인

배포 후 토큰이 비지 않았는지 응답 코드로 확인합니다. 토큰 없이 부르면 **401이 나와야 정상**입니다.

```powershell
curl -s -o NUL -w "%{http_code}`n" "https://gong-go-dev.<계정>.workers.dev/api/relay/1230000/ad/BidPublicInfoService/getBidPblancListInfoThngPPSSrch"
```

**상태 코드만으로는 부족합니다.** 중계 경로가 없는 구 배포본도 조회 화면의 게이트가 로그인
화면을 401로 돌려주기 때문에, 정상일 때와 코드가 같습니다. 본문까지 봐야 구분됩니다.

```powershell
curl -s -i "https://gong-go-dev.<계정>.workers.dev/api/relay/1230000/ad/BidPublicInfoService/getBidPblancListInfoThngPPSSrch" | Select-String "HTTP/|content-type"
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
npm run upload -- --dry-run
npm run upload
npx wrangler secret put GATE_PASSWORD
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put RELAY_TOKEN     # 이름이 정확해야 한다 — 아래 주의 참고
npm run deploy
```

> 시크릿 이름은 코드가 읽는 것과 **정확히** 같아야 합니다. Worker는 `env.RELAY_TOKEN`을
> 읽으므로 `RELAY` 같은 다른 이름으로 등록하면 값이 들어 있어도 중계가 501을 반환합니다.
> 세 개 모두 비대화형 셸에서 등록하지 마세요(아래 [토큰 등록](#토큰-등록) 경고 참고).

Cloudflare 시크릿은 `GATE_PASSWORD`, `GITHUB_TOKEN`, `RELAY_TOKEN` 세 개입니다. `GITHUB_TOKEN`이 없으면 배포 화면의 갱신 API가, `RELAY_TOKEN`이 없으면 중계가 501을 반환합니다. GitHub 저장소에는 Actions용 `SERVICE_KEY`, `API_BASE`, `RELAY_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`를 등록해야 합니다.

`.github/workflows/collect.yml`은 매일 KST 05:00에 실행되며, 배포 화면의 갱신 버튼도 같은 워크플로를 실행하고 완료 상태를 표시합니다.

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
