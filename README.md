# 나라장터 수집·분석 도구 (dev)

나라장터 공고를 수집해 첨부 문서에서 ECR 규격까지 뽑아내는 개발 브랜치입니다. 기능 단위로 폴더를 나누고, 모든 산출물은 공용 `data/` 한 곳에 모입니다.

> 운영 중인 실시간 조회 웹앱(`gong-go.pages.dev`)은 `main` 브랜치에 있습니다. 이 브랜치는 그 앱을 대체하지 않는 별도의 개발 라인입니다.

| 폴더 | 역할 | 실행 |
| --- | --- | --- |
| `collector/` | 공공데이터 API 공고 수집 (사전공고·본공고 CSV) | `npm run collect` |
| `downloader/` | 관심 공고의 첨부(제안요청서·과업내용서) 다운로드 | `npm run attachments` |
| `converter/` | HWP·HWPX·PDF·ZIP 첨부를 HWPX/Markdown으로 변환 | `npm run convert` |
| `analyzer/` | 변환 텍스트에서 ECR 규격 추출·검증 | `npm run analyze` |
| `shared/` | 공용 유틸(CSV 직렬화/파싱, 경로·gzip·동시성 헬퍼) | — |
| `public/` | 수집 데이터를 읽어 표시하는 순수 정적 페이지 | 정적 서버 |
| `data/` | 모든 단계의 입출력 데이터 (gitignore) | — |

설정과 비밀값 위치는 다음과 같습니다.

- `.env` (루트, gitignore): `SERVICE_KEY`, 필요 시 `ANTHROPIC_API_KEY`. `.env.example`을 복사해 만듭니다.
- `collector/sync.config.json`: 수집 기간·공고 구분·업무 구분·동시성
- `downloader/download.config.json`: 대상 기관·첨부 파일명 패턴·1회 처리 건수

## 데이터 레이아웃

```
data/
├─ pre|bid/YYYY/MM/DD.csv.gz          collector 산출물(날짜별 공고)
├─ index.json, sync-state.json        파일 목록·수집 진행 상태
├─ files/bid/<공고번호>/               downloader가 내려받은 원본 첨부
├─ norm/bid, text/bid                 converter 산출물(HWPX, Markdown .md.gz)
└─ analysis/bid, analysis-index.json  analyzer 산출물(ECR JSON)
```

## 수집

루트에서 `.env`와 `collector/sync.config.json`을 준비한 뒤 실행합니다.

```powershell
cd C:\gong-go
node collector/collector.js
```

## ECR 규격 추출

본공고 CSV를 수집한 뒤 순서대로 실행합니다. `--dry-run`으로 대상과 예상 비용만 먼저 확인할 수 있습니다.

```powershell
node downloader/attachments.js
node converter/convert.js
node analyzer/analyze.js --provider ollama --model qwen3.5-hermes-64k:latest
```

각 단계의 옵션은 폴더별 README를 참고하세요.

## 조회

저장소 루트에서 로컬 개발 서버를 실행하고 `http://localhost:8788/public/`을 엽니다.

```powershell
npm run serve
```

`devserver/server.js`는 저장소 루트를 정적 서빙하면서 갱신용 `/api/refresh`를 함께 제공합니다. 조회만 할 것이라면 `python -m http.server 8788`로도 되지만, 이 경우 **보유데이터 갱신 버튼은 동작하지 않습니다.**

### 보유데이터 갱신

페이지 상단에 보유 데이터의 날짜 범위와 건수가 표시되고, 옆의 **보유데이터 갱신** 버튼을 누르면 `/api/refresh`가 수집기를 실행합니다. 범위는 **보유 데이터의 마지막 날짜 ~ 오늘**로 자동 결정되며(마지막 날짜는 이후 추가 등록분을 반영하려고 다시 받습니다), 내부적으로 `node collector/collector.js --begin=... --end=... --no-resume`을 실행합니다. 수집이 끝나면 페이지가 `index.json`을 다시 읽어 늘어난 날짜를 자동으로 반영합니다.

전체 기간을 다시 받으려면 버튼이 아니라 `npm run collect`를 쓰세요. `sync.config.json`의 `begin`이 `2025-01-01`이라 전체 백필이 돕니다.

정적 페이지는 `data/index.json`과 `data/pre/YYYY/MM/DD.csv.gz`, `data/bid/YYYY/MM/DD.csv.gz`를 읽습니다. 날짜별 파일은 gzip으로 압축 저장하고, 브라우저에서 `DecompressionStream`으로 즉시 해제해 표시합니다. `index.html`을 파일 탐색기에서 직접 열면 브라우저 보안 정책 때문에 CSV를 읽을 수 없습니다.

## 테스트

```powershell
npm test
```
