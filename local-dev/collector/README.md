# 공고 수집기

이 폴더는 공공데이터 API 수집기와 로컬 데이터만 관리합니다. 정적 조회 페이지 파일은 상위 `public/` 폴더에 있습니다.

1. `.env.example`을 복사해 `.env`를 만들고 `SERVICE_KEY`를 설정합니다.
2. `sync.config.example.json`을 복사해 `sync.config.json`을 만듭니다.
3. `node collector.js`를 실행합니다.

수집 결과는 `data/YYYY/MM/DD.csv`, 파일 목록은 `data/index.json`, 진행 상태는 `data/sync-state.json`에 저장됩니다.
