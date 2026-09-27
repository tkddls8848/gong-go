# 저장 데이터 계약

작성기와 독자의 위치는 [코드 지도](code-map.md)에 있습니다. 변경 시 각 소비자의 테스트를 확인합니다.

## 현재 데이터 계약

- 인덱스 항목: `{ mode, begin, end, path, count }`
- 서비스 파일: gzip CSV만 사용
- 파일 경로: 일별 `{pre,bid,plan}/YYYY/MM/DD.csv.gz`, 월별 `{pre,bid,plan}/YYYY/MM.csv.gz`
- 배포 데이터: `index.json`, `analysis-index.json`, 서비스 CSV, 분석 JSON만 공개
- 보존: 서비스 CSV와 `raw/` 모두 2020년부터 전부 누적 보관

과거 평문 CSV나 구 인덱스 형식은 런타임에서 변환하지 않습니다.

## 발주계획의 제약

발주계획(`plan`)은 사전공고·본공고와 같은 화면에서 같은 방식으로 조회되지만, **보유 범위가 소급되지 않습니다.**

발주계획현황 API는 조회 범위 파라미터를 받아 형식까지 검증하면서도(`YYYYMMDD`를 주면 `DATE Format 에러`) 결과를 거르지 않습니다. `orderBgnYm`/`orderEndYm`, `inqryBgnDt`/`inqryEndDt`, `PPSSrch` 변형, `inqryDiv` 1~4를 모두 시험했지만 어떤 범위를 넣어도 같은 응답이 옵니다. 실제로 돌아오는 것은 최근 며칠 안에 게시된 계획뿐입니다.

그래서 수집기는 이 모드를 스냅샷으로 다룹니다. 매 실행이 "지금 열려 있는 창"을 한 번 떠 오고, 게시일시(`nticeDt`)로 일자를 갈라 누적합니다. **과거는 받을 수 없고 수집을 시작한 시점부터 쌓입니다.**

이 성질 때문에 두 곳에 예외가 있습니다. 둘 다 없으면 크론이 돌 때마다 누적분이 사라집니다.

- `collector/collector.js`: `--no-resume`이 수집 구간을 비우는 `clearJobRange`를 스냅샷 모드에서는 건너뜁니다
- `uploader/upload.js`: `vanishedDaily`가 `RANGED_DAILY_KEY`(= `pre`·`bid`만)를 보므로, 로컬에 없는 원격 `plan` 키를 지우지 않습니다
