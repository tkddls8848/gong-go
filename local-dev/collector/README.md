# 공고 수집기

이 폴더는 공공데이터 API 수집기와 로컬 데이터만 관리합니다. 정적 조회 페이지 파일은 상위 `public/` 폴더에 있습니다.

1. `.env.example`을 복사해 `.env`를 만들고 `SERVICE_KEY`를 설정합니다.
2. `sync.config.example.json`을 복사해 `sync.config.json`을 만듭니다.
3. `node collector.js`를 실행합니다.

수집 결과는 `data/YYYY/MM/DD.csv.gz`, 파일 목록은 `data/index.json`, 진행 상태는 `data/sync-state.json`에 저장됩니다.

## ECR 규격 추출

본공고 CSV를 수집한 뒤 아래 순서로 실행합니다. 모든 산출물은 gitignore된 `data/files`, `data/norm`, `data/text`, `data/analysis`에만 저장됩니다.

```powershell
# 대상/예상 비용만 확인
node attachments.js --dry-run
node analyze.js --dry-run

# 관심 첨부 다운로드 → HWP/HWPX/PDF 정규화 → Claude 분석
node attachments.js
node convert.js
node analyze.js --provider ollama --model qwen3.5-hermes-64k:latest
```

`analyze.js`의 기본 provider는 로컬 Ollama이며 `qwen3.5-hermes-64k:latest`를 기본 모델로 씁니다. Ollama는 변환된 Markdown(HWPX 경로)이 필요하고 PDF 원문은 바로 분석하지 않습니다. Anthropic을 명시적으로 선택한 경우에만 `ANTHROPIC_API_KEY`와 `--yes` 비용 승인이 필요합니다. `--limit N`, `--force`, `--dry-run`을 지원합니다. HWP 변환은 한글 COM 자동화를 사용하므로, 첫 실행에서는 소량으로 보안 팝업·성공률을 먼저 확인해야 합니다.
