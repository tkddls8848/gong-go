# 나라장터 수집·분석 도구 (dev)

나라장터 공고를 수집해 첨부 문서에서 ECR 규격까지 뽑아내는 개발 브랜치입니다. 기능 단위로 폴더를 나누고, 모든 산출물은 공용 `data/` 한 곳에 모입니다.

> 운영 중인 실시간 조회 웹앱(`gong-go.pages.dev`)은 `main` 브랜치에 있습니다. 이 브랜치는 그 앱을 대체하지 않는 별도의 개발 라인입니다.

| 폴더 | 역할 | 실행 |
| --- | --- | --- |
| `collector/` | 공공데이터 API 공고 수집 (사전공고·본공고 CSV) | `npm run collect` |
| `downloader/` | 관심 공고의 첨부(제안요청서·과업내용서) 다운로드 | `npm run attachments` |
| `converter/` | HWP·HWPX·PDF·ZIP 첨부를 HWPX/Markdown으로 변환 | `npm run convert` |
| `analyzer/` | 변환 텍스트에서 ECR 규격 추출·검증 | `npm run analyze` |
| `shared/` | 공용 유틸(CSV 직렬화/파싱, 경로·gzip·동시성 헬퍼, 서비스 컬럼 정의) | — |
| `public/` | 수집 데이터를 읽어 표시하는 순수 정적 페이지 | 정적 서버 |
| `devserver/` | 로컬 전용 정적 서버 + 갱신 API(`/api/refresh`) | `npm run serve` |
| `docs/` | 배포 계획(Git-정적 방식 / R2 방식) | — |
| `data/` | 모든 단계의 입출력 데이터 (gitignore) | — |

설정과 비밀값 위치는 다음과 같습니다.

- `.env` (루트, gitignore): `SERVICE_KEY`, 필요 시 `ANTHROPIC_API_KEY`. `.env.example`을 복사해 만듭니다.
- `collector/sync.config.json`: 수집 기간·공고 구분·업무 구분·동시성 (현재 `begin`은 `2020-01-01`)
- `downloader/download.config.json`: 대상 기관·첨부 파일명 패턴·1회 처리 건수

## 데이터 레이아웃

```
data/
├─ pre|bid/YYYY/MM/DD.csv.gz          collector 산출물(날짜별 공고, 서비스 컬럼만)
├─ index.json, sync-state.json        파일 목록·수집 진행 상태
├─ raw/pre|bid/YYYY/MM/DD.csv.gz      슬림화 전 원본(170여 컬럼) 백업
├─ backup/raw-full.csv.gz             원본을 한 파일로 합친 백업
├─ files/bid/<공고번호>/               downloader가 내려받은 원본 첨부
├─ norm/bid, text/bid                 converter 산출물(HWPX, Markdown .md.gz)
└─ analysis/bid, analysis-index.json  analyzer 산출물(ECR JSON)
```

`data/` 전체가 gitignore이며, `data/raw/`·`data/backup/`은 배포용으로 gitignore 범위를 좁히더라도 절대 커밋되지 않도록 별도 규칙으로 한 번 더 제외합니다.

## 수집

루트에서 `.env`와 `collector/sync.config.json`을 준비한 뒤 실행합니다.

```powershell
npm run collect                                                    # sync.config.json 기준
node collector/collector.js --begin=2026-07-01 --end=2026-08-02    # 이번 실행만 범위 지정
```

`--begin`/`--end`/`--no-resume`은 설정 파일을 건드리지 않고 해당 실행에만 적용됩니다. 진행 상태는 `data/sync-state.json`에 남아 중단 후 재실행하면 끝난 작업을 건너뜁니다. `--migrate-only`는 API 호출 없이 데이터 디렉터리 정리만 합니다.

### 장기간 소급 수집

몇 년치를 한 번에 받을 때는 `collector.js`를 직접 돌리지 말고 백필 드라이버를 씁니다. 분기 단위로 **순차** 실행해 힙 초과와 `index.json` 덮어쓰기를 피합니다.

```powershell
node collector/backfill.js --from=2020-01-01 --to=2026-08-02 --heap=4096
```

수집기는 개별 작업이 실패해도 종료 코드 0으로 끝나므로, 백필이 분기마다 `data/sync-errors.json`을 확인해 실패 건을 `data/backfill-errors.json`에 모아 둡니다. 429·쿼터 초과가 섞여 있으면 한도가 초기화된 뒤 같은 명령을 다시 실행하면 실패분만 다시 받습니다. **여러 기간을 병렬로 실행하면 서로의 인덱스를 지웁니다.**

## 서비스 컬럼과 원본 보존

수집기는 저장 시점에 `shared/service-columns.js`가 정의한 컬럼만 남깁니다(본공고 30개, 사전공고 17개). 원본 170여 컬럼 중 낙찰방법·담당자 연락처·예산 항목 등은 조회 UI와 파이프라인 어디서도 쓰지 않아 파일이 약 70% 작아집니다.

이 규칙이 생기기 전에 받아 둔 파일은 한 번만 정리하면 됩니다. `slim.js`는 원본을 `data/raw/`로 복사한 뒤에 줄이므로 손실이 없습니다.

```powershell
npm run slim -- --dry-run   # 대상 파일 수와 예상 절감량만 확인
npm run slim
npm run export-raw          # data/raw를 data/backup/raw-full.csv.gz 한 파일로 합침
```

나중에 다른 컬럼이 필요해지면 재수집 없이 `data/raw/`나 통합 백업에서 꺼내면 됩니다.

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

화면은 사전공고·본공고 토글, 관심 기관 목록(브라우저 `localStorage`에 저장), 검색어·업무구분·게시일 필터를 제공합니다. 사업명을 누르면 첨부 목록과 분석된 ECR 규격을 모달로 보여 주고, 조회 결과는 CSV로 내려받을 수 있습니다(ECR은 항목 단위로 펼쳐서 내보내기).

### 보유데이터 갱신

페이지 상단에 보유 데이터의 날짜 범위와 건수가 표시되고, 옆의 **보유데이터 갱신** 버튼을 누르면 `/api/refresh`가 수집기를 실행합니다. 범위는 **보유 데이터의 마지막 날짜 ~ 오늘**로 자동 결정되며(마지막 날짜는 이후 추가 등록분을 반영하려고 다시 받습니다), 내부적으로 `node collector/collector.js --begin=... --end=... --no-resume`을 실행합니다. 수집이 끝나면 페이지가 `index.json`을 다시 읽어 늘어난 날짜를 자동으로 반영합니다.

전체 기간을 다시 받으려면 버튼이 아니라 `node collector/backfill.js`를 쓰세요. `sync.config.json`의 `begin`이 `2020-01-01`이라 `npm run collect`로 전체 백필을 돌리면 한 프로세스에 6년치가 쌓여 힙이 터집니다.

정적 페이지는 `data/index.json`과 `data/pre/YYYY/MM/DD.csv.gz`, `data/bid/YYYY/MM/DD.csv.gz`를 읽습니다. 날짜별 파일은 gzip으로 압축 저장하고, 브라우저에서 `DecompressionStream`으로 즉시 해제해 표시합니다. `index.html`을 파일 탐색기에서 직접 열면 브라우저 보안 정책 때문에 CSV를 읽을 수 없습니다.

## 배포

아직 배포 전이며 계획 문서만 있습니다.

- `docs/배포계획.md`: gzip 데이터를 Git에 커밋해 Cloudflare Pages가 정적 서빙하는 방식
- `docs/배포계획-R2.md`: 2026-08-03 실측(배포 대상 288MB·4,754파일·321만건, `data/raw` 651MB)을 근거로 **R2 방식을 채택**한 실행 계획. 되돌릴 수 없는 Git 커밋 대신 R2 버킷 + 중계 Function을 쓰고, 호출당 비용을 줄이려고 월별 봉인(`collector/compact.js`)과 업로더를 추가합니다

## 테스트

```powershell
npm test
```
