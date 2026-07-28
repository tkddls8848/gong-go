# collector — 공고 수집

공공데이터포털 나라장터 API에서 사전공고·본공고를 받아 날짜별 CSV로 저장합니다.

1. 루트의 `.env.example`을 복사해 `local-dev/.env`를 만들고 `SERVICE_KEY`를 설정합니다.
2. `sync.config.json`에서 수집 기간·공고 구분·업무 구분·동시성을 조정합니다.
3. `node collector/collector.js`를 루트에서 실행합니다.

수집 결과는 `../data/pre|bid/YYYY/MM/DD.csv.gz`, 파일 목록은 `../data/index.json`, 진행 상태는 `../data/sync-state.json`에 저장됩니다. 실행은 `sync-state.json`의 완료 작업 목록으로 재개되며, `sync.config.json`의 `resume: false`는 해당 구간을 다시 받아 덮어씁니다.

`--migrate-only`는 API 호출 없이 데이터 디렉터리 이관·정리만 수행합니다.
