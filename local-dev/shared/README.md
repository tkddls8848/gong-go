# shared — 공용 유틸

여러 단계가 함께 쓰는 코드만 둡니다. 외부 의존성은 없습니다.

- `csv-record.js`: 수집 CSV 직렬화/파싱. Excel 텍스트 강제 수식(`="값"`)을 RFC 4180 인용으로 감싸고, 빈 셀은 그대로 빈 필드로 둡니다.
- `pipeline-utils.js`: 경로 상수(`ROOT` = local-dev 루트, `DATA_DIR` = `ROOT/data`), `.env` 로더, 동시성 풀(`mapPool`), JSON·gzip 읽기/쓰기, 공고 레코드 필드 접근자(`noticeNumber`, `institution`, `normalizeFiles` 등).

경로 상수를 여기서 한 번만 정의하므로, 각 단계는 `DATA_DIR` 아래 자기 산출물 경로만 알면 됩니다.
