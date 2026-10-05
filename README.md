# 나라장터 공고·ECR 조회

나라장터 사전공고·본공고·발주계획을 수집해 검색하고, 본공고 첨부 문서에서 ECR 규격을 추출하는 개인용 서비스입니다. 운영 경로는 Cloudflare Worker + R2입니다. 수집은 GitHub Actions가 돌리며, 업무 시간대(KST 09~18시) 매시 어제~오늘은 Worker의 크론이 그 워크플로를 실행하고, 매일 새벽에는 워크플로 자체의 스케줄이 최근 35일을 다시 받습니다.

**ECR 분석 결과는 서버에 저장하지 않습니다.** 올린 제안요청서로 규격을 뽑아 화면에 응답으로 전달하고, 끝난 작업의 R2 자료는 지웁니다. 결과는 그 자리에서 CSV로 내려받습니다 — 탭을 닫으면 다시 분석해야 하고 비용이 새로 듭니다.

파일을 찾을 때는 **[기능별 코드 지도](docs/code-map.md)**부터 확인합니다.

## 구성

- `collector/`: 공공데이터 API 수집, 일별 gzip CSV 저장, 지난 월 봉인
- `downloader/` → `analyzer/`: 첨부 다운로드, ECR 분석. 그 사이의 **문서 변환(HWP/HWPX→Markdown)은 이 저장소에 없다** — 별도 저장소 `orca/quotation`의 `converters/`가 맡는다
- `uploader/`: 변경된 서비스 CSV와 raw 원본만 R2 업로드. ECR 분석 결과는 올리지 않는다
- `public/`: 조회 화면. `app.js`가 기능 모듈을 조립하고, 검색·갱신·ECR·모달·내보내기는 각각의 파일이 맡는다. `rows.js`는 화면과 검색 Worker의 파서·행 모델이다. `robots.txt`만 화면이 아니라 크롤러에게 하는 말이다 — [크롤러와 AI 수집](docs/search.md#크롤러와-ai-수집)
- `src/worker.js`: 인증 순서와 라우팅. 게이트는 `gate.js`, 저장 데이터 제공은 `data.js`, API 구현은 `live.js`·`refresh.js`·`relay.js`·`ask-handler.js`·`ecr.js`에 있다. ECR은 `ecr-source.js`(표 선별), `ecr-coverage.js`(누락 대조), `ecr-errors.js`(단계별 오류), `ai-access.js`(분석 전용 잠금), `ai-budget.js`(뉴런 예약·정산)가 나눠 맡는다
- `test/`: 조회 화면용 테스트. 나머지 테스트는 대상 옆에 두지만 이것만 떼어 놓는다 — `public/`은 wrangler의 자산 디렉터리라 그 안의 파일은 전부 사이트로 배포된다

산출물은 모두 gitignore된 `data/`에 저장합니다.

```text
data/
├─ pre|bid|plan/YYYY/MM/DD.csv.gz   일별 서비스 데이터
├─ pre|bid|plan/YYYY/MM.csv.gz      봉인된 월 데이터
├─ raw/pre|bid|plan/...             원본 컬럼 백업(2020년~, 보존 기한 없음)
├─ files|norm|text/bid/...     첨부와 변환 결과
└─ analysis/bid/...            로컬 CLI 분석 결과(운영 화면과 무관, 업로드하지 않음)
```

### 모듈 경계 — 공유 코드를 두지 않는다

**각 모듈은 제가 쓰는 것을 제 안에 전부 구현한다. 모듈을 가로지르는 공용 디렉터리는 두지 않는다.**
공유는 해당 기능 모듈 **안에서만** 한다(예: `collector/csv-record.js`는 `collector.js`와 `compact.js`가
함께 쓴다). 예전의 `shared/`는 없앴고, 그 안에 있던 것은 쓰는 모듈마다 제 사본을 갖는다.

이유는 장애 전파다. 공용 파일 한 줄을 고치면 수집·다운로드·변환·분석·업로드·조회가 한꺼번에
영향권에 들어온다. 이 저장소는 단계마다 실행 주체와 실행 시점이 다르다(크론 러너, 로컬 PC,
Cloudflare Worker). 한 단계를 고치다 다른 단계를 멈추는 것이 가장 비싼 사고다.

**모듈 사이에 실제로 있는 계약은 코드가 아니라 데이터다.**

| 계약 | 정하는 곳 | 읽는 곳 |
| --- | --- | --- |
| CSV 저장 형식 (BOM + 헤더 + `="값"`) | `collector/csv-record.js` | `downloader/attachments.js`, `public/rows.js` |
| `index.json` 항목 `{mode,begin,end,path,count}` | `collector/store.js` | `uploader/upload.js`, `public/data-index.js` |
| `data/` 디렉터리 구조 | `collector/` | 그 아래 모든 단계 |

그래서 같은 모양의 함수가 여러 곳에 있다 — CSV 파서는 쓰는 쪽 하나(`collector/`)와 읽는 쪽
둘(`downloader/`, `public/`)에 각각 있고, 인덱스 항목을 만드는 규칙은 `collector/`와 `uploader/`에
각각 있다. 실행 단계의 독립성을 위해 사본을 허용하며, 위 표의 데이터 계약을 유지한다.
각 사본은 제 모듈의 테스트가 따로 고정한다(`collector/csv-record.test.js`,
`downloader/attachments.test.js`, `test/rows.test.js`, `collector/store.test.js`, `uploader/upload.test.js`).

**새 코드를 넣을 때의 규칙**

1. 운영 코드에서 다른 최상위 모듈의 파일을 `require`/`import`하지 않는다. 필요하면 제 모듈 안에 구현한다.
2. 기능별 파일은 사용처가 하나여도 분리한다. 공용 유틸리티는 같은 모듈 안에서 두 파일 이상이 사용할 때 만든다.
3. 사본을 만들 때는 원본 파일명을 주석으로 적고(형식이 같다는 뜻), 그 사본의 테스트를 함께 둔다.
4. 계약(위 표)을 바꿔야 하면 문서를 먼저 고치고, 읽는 쪽 사본을 하나씩 따라 고친다.

## 실행과 검증

Node.js 22.7 이상에서 의존성을 설치합니다(CI는 22에서 검증합니다). 환경변수와 운영 명령은 [설치와 운영](docs/operations.md)을 참고합니다.

~~~powershell
npm ci
npm test                    # 기본 검증
npm run test:browser        # 화면 연결을 바꿨을 때
npm run test:runtime        # Worker 연결을 바꿨을 때
npm run test:selection      # ECR 표 선별을 바꿨을 때(실문서 표본 대조)
npx wrangler deploy --dry-run   # 번들을 바꿨을 때
~~~

`test:selection`이 읽는 실문서 텍스트는 저장소 밖(`../gong-go-eval/`)에 둡니다. 파일이 없으면
그 문서를 건너뛰고 나머지만 검사합니다.

## 상세 문서

| 작업 | 문서 |
| --- | --- |
| 코드·대응 테스트 찾기 | [코드 지도](docs/code-map.md) |
| 환경변수, 수집, 중계, R2, 배포 | [설치와 운영](docs/operations.md) |
| 공고 검색, 프리셋, 자연어 검색 | [조회 화면](docs/search.md) |
| ECR 분석·잠금·비용·검증 | [ECR](docs/ecr.md) |
| 브라우저 HWP·HWPX → PDF 변환 | [한글 문서 변환](docs/hwp-conversion.md) |
| 로컬 첨부 다운로드·분석 | [로컬 분석](docs/local-analysis.md) |
| CSV·인덱스·발주계획 제약 | [데이터 계약](docs/data-contracts.md) |
| 품질 기준과 개선 기록 | [서비스 품질](docs/service-quality.md) |
| 배포 검증과 되돌리기 | [출시 체크리스트](docs/release-checklist.md) |
| 구조 감사와 정리 절차 | [리팩터링 1단계 감사](docs/refactoring-audit.md), [2단계 정리](docs/refactoring-cleanup.md) |
| 과거 조사와 설계 결정 | [기술 기록 목록](docs/프로젝트-통합-문서.md) |
