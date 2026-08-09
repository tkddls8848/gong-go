# 나라장터 공고·ECR 조회

나라장터 사전공고와 본공고를 수집해 검색하고, 본공고 첨부 문서에서 ECR 규격을 추출하는 개인용 서비스입니다. 운영 경로는 Cloudflare Worker + R2이며, 매일 GitHub Actions가 최근 35일을 다시 수집합니다.

## 구성

- `collector/`: 공공데이터 API 수집, 일별 gzip CSV 저장, 지난 월 봉인
- `downloader/` → `converter/` → `analyzer/`: 첨부 다운로드, HWPX/Markdown 변환, ECR 분석
- `uploader/`: 변경된 데이터만 R2 업로드
- `public/`: 조회 화면
- `src/worker.js`: 비밀번호 인증, 정적 자산/R2 제공, 원격 갱신 실행
- `shared/`: CSV와 파이프라인 공용 함수

산출물은 모두 gitignore된 `data/`에 저장합니다.

```text
data/
├─ pre|bid/YYYY/MM/DD.csv.gz   일별 서비스 데이터
├─ pre|bid/YYYY/MM.csv.gz      봉인된 월 데이터
├─ raw/pre|bid/...             원본 컬럼 백업
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

## R2 업로드와 배포

```powershell
npm run compact              # 40일보다 오래된 월을 봉인
npm run compact -- --prune   # 봉인 확인 후 같은 월의 일별 파일 삭제
npm run upload -- --dry-run
npm run upload
npx wrangler secret put GATE_PASSWORD
npx wrangler secret put GITHUB_TOKEN
npm run deploy
```

Cloudflare 시크릿 두 개가 모두 필요합니다. `GITHUB_TOKEN`이 없으면 배포 화면의 갱신 API가 501을 반환합니다. GitHub 저장소에는 Actions용 `SERVICE_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`도 등록해야 합니다.

`.github/workflows/collect.yml`은 매일 KST 05:00에 실행되며, 배포 화면의 갱신 버튼도 같은 워크플로를 실행하고 완료 상태를 표시합니다.

## 현재 데이터 계약

- 인덱스 항목: `{ mode, begin, end, path, count }`
- 서비스 파일: gzip CSV만 사용
- 파일 경로: 일별 `{pre,bid}/YYYY/MM/DD.csv.gz`, 월별 `{pre,bid}/YYYY/MM.csv.gz`
- 배포 데이터: `index.json`, `analysis-index.json`, 서비스 CSV, 분석 JSON만 공개

과거 평문 CSV나 구 인덱스 형식은 런타임에서 변환하지 않습니다.
