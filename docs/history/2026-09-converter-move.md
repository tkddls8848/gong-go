# 6부. 변환기를 저장소 밖으로 (2026-09-13)

> 당시 조사·결정의 기록입니다. 현재 파일 위치와 작업 기준은 [코드 지도](../code-map.md)를 먼저 확인하세요. 배포 상태·남은 작업·테스트 수치는 작성 당시 기준입니다.

**상태**: `converter/` 삭제 완료 · `npm test` 통과 · 구현은 `orca/quotation`의 `converters/`로 이관

## 1. 무엇을 왜 뺐나

`converter/`(HWP→HWPX 한글 COM 호출, HWPX 파서, ZIP reader)는 **이 서비스가 돌리는 코드가
아니었다.** 라이브 경로는 Cloudflare Worker + R2 + GitHub Actions 러너인데, 한글 COM은
Windows에 설치된 한글이 있어야만 돈다. 즉 크론도 Worker도 이 모듈을 부를 수 없고, 개발자
PC에서 손으로 돌리는 단계로만 남아 있었다.

같은 기능을 실제로 쓰는 곳은 따로 있다 — `orca/quotation`이 PDF↔HWP 변환기 탭을 만들고 있고,
그 저장소의 `converters/`가 자리와 규칙까지 잡아 둔 상태였다. 5부의 기준(공유부를 밖에 두지
않는다)을 저장소 사이에도 그대로 적용해, **쓰는 쪽이 구현을 갖는다.**

## 2. 남은 계약

수집·다운로드·분석은 그대로 있다. 변환 단계만 빠졌고, 그 자리는 **데이터 규약**으로 이어진다.

```text
downloader (이 저장소)  →  data/files/bid/<공고번호>/NN_이름.hwp
                              ↓  (orca/quotation 의 converters/)
analyzer   (이 저장소)  ←  data/text/bid/<공고번호>/manifest.json + NN.md.gz
```

`analyzer/analyze.js`가 보는 것은 `manifest.documents[]`의 `kind`(`hwpx`/`pdf`), `markdown`,
`source`, `originalName`뿐이다. 그 모양만 지키면 변환기를 무엇으로 바꾸든 분석은 그대로다.
README "첨부·ECR 파이프라인"에 같은 표를 적어 두었다.

## 3. 같이 지운 것

- `package.json`의 `convert` 스크립트
- README 구성의 `converter/` 항목과 파이프라인 명령
- 3부 §3·§5·§7의 "흔적"은 지우지 않고 **이 저장소를 떠났다는 사실만 덧붙였다.** 그 판단은
  이제 `orca/quotation`이 한다.

## 4. 검증

| 검증 | 결과 |
|---|---|
| `npm test` | 통과 (변환기 테스트 2건이 저장소를 떠나 그만큼 줄었다) |
| `grep -r "converter/"` | 코드에 남은 참조 없음(문서의 이력 설명만 남음) |
| `npm run attachments --dry-run` / `analyze --dry-run` | 정상 종료 — 변환 단계 없이도 양끝이 각자 돈다 |
