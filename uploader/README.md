# uploader

`data/`의 배포 대상 산출물을 Cloudflare R2 버킷으로 올린다. 배포본은 이 버킷을
`functions/data/[[path]].js`가 게이트 뒤에서 중계해 읽는다. 설계 근거는
[docs/배포계획-R2.md](../docs/배포계획-R2.md) R2-7.

```powershell
node uploader/upload.js --dry-run     # 올릴/지울 대상만 출력
node uploader/upload.js               # 실제 업로드
node uploader/upload.js --pull-state  # R2의 sync-state.json을 data/로 내려받기
```

## 자격증명

`.env` 또는 환경변수로 넣는다. 토큰은 **버킷 한정 Object Read & Write**로 발급한다.

| 이름 | 필수 | 설명 |
|---|---|---|
| `R2_ACCOUNT_ID` | ○ | 엔드포인트 `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | ○ | |
| `R2_SECRET_ACCESS_KEY` | ○ | |
| `R2_BUCKET` | | 기본 `gong-go-data` |

## 무엇을 올리는가

| 키 | 원본 |
|---|---|
| `{pre,bid}/YYYY/MM/DD.csv.gz` | 일별 파일 |
| `{pre,bid}/YYYY/MM.csv.gz` | `collector/compact.js`가 봉인한 월 파일 |
| `index.json` | 로컬 인덱스와 **버킷 인덱스를 합쳐** 새로 만든다(아래) |
| `analysis-index.json`, `analysis/bid/*.json` | analyzer 산출물(있을 때만) |
| `state/sync-state.json` | 러너 전용 증분 상태. 뷰어 라우팅이 막는 위치다 |

`data/raw`(170컬럼 원본)·`data/files`·`data/text`·`sync-errors.json`은 올리지 않는다.

## 변경분만 올린다

버킷의 키+ETag를 `ListObjectsV2`로 받아 로컬 MD5와 대조한다. **별도의 상태 파일이 없다 —
버킷 자체가 상태다.** `zlib.gzipSync`는 MTIME을 0으로 쓰므로 같은 입력이면 항상 같은
바이트가 나오고, 재수집해도 내용이 같은 파일은 여기서 걸러진다.

## 순서를 지킨다

R2에는 트랜잭션이 없다. 순서가 유일한 방어다.

```
① *.csv.gz PUT                   파일이 인덱스보다 먼저 있어야 한다
② index.json PUT                 (버킷 인덱스와 병합한 결과)
③ 봉인으로 대체된 일별 키 DELETE   인덱스가 바뀐 뒤에 지운다
④ analysis/bid/*.json PUT
⑤ analysis-index.json PUT        목록은 목록이 가리키는 파일보다 뒤에
```

①보다 ②가 먼저면 아직 없는 파일을 프런트가 요청한다. ②보다 ③이 먼저면 구 인덱스를
캐시한 브라우저가 사라진 일별 파일에서 404를 만난다.

## 삭제 규칙 — 두 가지뿐

크론 러너는 최근 35일치만 로컬에 갖고 있다. **"로컬에 없으면 지운다"로 만들면 나머지
전부가 삭제 대상이 된다.** 그래서 판정은 버킷 안 정보나 명시된 구간으로만 한다.

1. `(pre|bid)/YYYY/MM/DD.csv.gz` 를 지운다 — 버킷에 `(pre|bid)/YYYY/MM.csv.gz` 가 있을 때만.
2. `SYNC_BEGIN`(있으면 `SYNC_END`까지) 구간 안에서 로컬에 없어진 일별 키를 지운다.
   그날 공고가 0건이 되어 collector가 파일을 지운 경우다. 구간 밖은 손대지 않는다.

`state/`·`raw/`·`analysis/` 프리픽스는 애초에 대상이 아니다. 두 규칙 모두
[upload.test.js](upload.test.js)가 검증한다.

## index.json을 합치는 이유

로컬 인덱스를 그대로 올리면 **최근 35일치만 가진 크론 러너가 과거 항목을 전부 지워
버린다.** 그래서 인덱스는 "이번 실행 뒤 버킷에 남을 데이터 키"의 투영으로 다시 만든다.
건수는 로컬 인덱스를 우선하고, 로컬에 없는 키는 버킷의 기존 인덱스에서 승계한다.

## 월 1회 봉인 루틴

봉인은 전체 데이터가 있는 로컬에서만 가능하다(러너에는 묶을 재료가 없다).

```powershell
node collector/compact.js --dry-run   # 대상 확인
node collector/compact.js             # 봉인 (일별 파일은 남는다)
node collector/compact.js --prune     # 결과 확인 후 로컬 일별 파일 정리
node uploader/upload.js               # 월 파일 PUT + 대체된 일별 키 DELETE
```

`--prune`을 업로드보다 **먼저** 두는 편이 싸다. 삭제 판정이 버킷 상태만 보므로 결과는
같은데, 로컬 일별 파일이 남아 있으면 지울 파일을 굳이 한 번 올리게 된다(초기 적재에서
4,914건 대 285건 차이다). 봉인 결과를 확인하기 전에는 `--prune`을 돌리지 않는다.
