# 로컬 도구 구조

프로덕션 Pages 앱과 분리된 로컬 도구입니다.

- `collector/`: 공공데이터 API 수집기, API 키·수집 설정·날짜별 CSV 데이터
- `public/`: CSV를 읽어 표시하는 순수 정적 웹 페이지

## 수집

`collector` 폴더에서 `.env`와 `sync.config.json`을 준비한 뒤 실행합니다.

```powershell
cd collector
node collector.js
```

## 조회

`local-dev` 폴더에서 정적 파일 서버를 실행하고 `http://localhost:8788/public/`을 엽니다.

```powershell
python -m http.server 8788
```

정적 페이지는 `collector/data/index.json`과 `collector/data/YYYY/MM/DD.csv` 날짜별 CSV를 읽습니다.
