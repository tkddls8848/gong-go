# 로컬 Ollama ECR 추출 실험 결과와 보완점

작성일: 2026-07-23

## 요약

로컬 Ollama 경로는 API 키·외부 AI 호출·과금 없이 ECR 추출을 시험할 수 있다. 다만 현재 PC의 `qwen3.5-hermes-64k:latest`와 Ollama 0.32.0 조합에서는 장문 문서와 구조화 JSON 출력을 함께 처리할 때 모델 연결이 종료되거나 요청이 장시간 대기했다. 따라서 현 상태의 결과는 **실험용**이며, 검증을 통과한 자동 추출 결과로 사용하면 안 된다.

## 실행 환경

- Ollama: 0.32.0, `http://127.0.0.1:11434`
- 모델: `qwen3.5-hermes-64k:latest` (약 3.4GB)
- 입력 샘플: `public/rfp_sample/[과업내용서] IoT 기반 탑승교 시설관리 고도화 사업.pdf`
- PDF 텍스트 추출: 27쪽, 38,439자
- 실험용 입력: 총괄표와 ECR-001~012 상세가 포함되는 앞 16,000자
- 실행 명령:

```powershell
node analyze.js --provider ollama --model qwen3.5-hermes-64k:latest
```

## 관찰 결과

| 항목 | 결과 | 판단 |
|---|---|---|
| 짧은 JSON 응답 | 정상 완료 | Ollama 서비스와 모델 자체는 동작함 |
| 64k 컨텍스트 장문 요청 | 약 5분 뒤 `fetch failed` | 현재 GPU/런타임 조건에서 안정적으로 사용 불가 |
| 24k 컨텍스트 장문 요청 | 동일하게 모델 종료 단계로 전환 | 단순 컨텍스트 축소만으로 해결되지 않음 |
| 8k 컨텍스트 + JSON 모드 | 호출은 일부 성공, 총괄표 ID가 일부만 반환 | 소형/로컬 모델의 표 인식·지시 준수 한계 확인 |
| JSON Schema 강제 | 장문 요청에서 연결 종료 경향 | Ollama 경로에서는 JSON 모드가 더 안정적 |
| thinking 비활성화 | 짧은 응답은 정상화 | 장문 구조화 호출의 근본 해결책은 아님 |
| HWP COM 변환 | 실제 CFB/HWP에서 30초 안에 완료되지 않음 | 보안 팝업 또는 COM 자동화 대기 문제를 먼저 해결해야 함 |

## 이미 반영한 보완

- `analyze.js`에 `--provider ollama --model ...` 옵션을 추가하고 Ollama를 기본 provider로 설정했다.
- Ollama 호출은 `think: false`, `format: "json"`, 2분 타임아웃을 사용한다.
- ECR 상세 요청은 2개 ID씩 분할하고, 해당 ID 주변 원문만 모델에 전달한다.
- Ollama가 영문 키를 반환하는 경우를 위해 `requirementsList`, `ecrDetails`, `basicSpecs` 등의 키를 내부 한국어 스키마로 정규화한다.
- 문서의 3자리 ECR 상세 ID를 보조 집합으로 사용해, 총괄표를 일부만 옮긴 모델 응답의 누락을 감지한다.
- `verifyExtraction`은 ID 집합, 선언 개수, 세부내용 원문 발췌를 대조한다. 검증 실패 결과는 `verified: false`로 유지한다.

## 우선 보완 과제

### 1. 모델·런타임 안정성 측정

동일한 입력으로 아래 모델을 순서대로 비교한다.

1. `qwen3.5-hermes-2b-64k:latest` — 더 작은 모델이므로 우선 안정성 확인용
2. `qwen3.5:4b` — Hermes 튜닝 영향과 기본 모델을 비교
3. `gemma4:e4b` — 메모리 여유가 있을 때만 시도

각 조합에서 `num_ctx` 4k / 8k / 12k와 입력 문자 수를 바꿔 다음을 기록한다.

- Pass A 및 Pass B 성공률
- 호출별 경과 시간, GPU/CPU 사용률
- Ollama 연결 종료 여부
- ECR ID 재현율
- 원문 대조를 통과한 ECR 수

`qwen3.5-hermes-64k`는 현재 장문 분석의 기본 모델로 사용하지 않는다. 짧은 JSON 호출만 정상인 상태다.

### 2. 로컬용 입력 분할기를 독립화

현재는 단순히 ID 주변 문자열을 자른다. 이를 문서 구조에 맞는 분할기로 교체한다.

- Pass A: 목차·사업 개요·요구사항 총괄표 영역만 입력
- Pass B: 각 ECR 표의 시작부터 다음 ECR 표 직전까지 입력
- 표 병합/쪽 넘김이 있는 PDF는 페이지 번호·표 단위 경계를 함께 보존
- 각 조각에 `sourceRange`, `page`, `charStart`, `charEnd` 메타데이터 저장

이렇게 하면 8k 컨텍스트에서도 전체 문서를 재전송하지 않고, 원문 검증 위치도 명확해진다.

### 3. PDF 텍스트 추출 경로를 정식화

이번 실험은 임시 `pypdf`로 PDF 텍스트를 뽑았다. 운영 경로에는 재현 가능한 도구 선택이 필요하다.

- Node 의존성 0 원칙을 유지한다면 Poppler `pdftotext`를 명시적 사전 조건으로 둔다.
- 또는 `pypdf`/PyMuPDF를 별도 Python 가상환경과 requirements 파일로 고정한다.
- PDF 선형 텍스트는 표 순서를 깨뜨릴 수 있으므로, 로컬 Ollama 결과에는 PDF 기반 여부를 표시하고 `verified` 통과 조건을 더 엄격하게 적용한다.

### 4. HWP COM 게이트를 별도 도구로 분리

현재 HWP→HWPX 변환은 한글 COM 호출이 응답하지 않아 배치 실행을 막는다.

- 1건씩 실행하는 `hwp-com-gate` 명령을 둔다.
- 실행 시간, `RegisterModule` 반환값, 프로세스 종료 여부, 결과 HWPX 파일 크기를 기록한다.
- 제한 시간 초과 시 해당 HWP 프로세스 ID만 종료하고 실패 manifest를 남긴다.
- 보안 모듈 팝업이 재현되면 대량 변환을 중단하고 `hwp5html` 등 폴백을 평가한다.

COM 게이트가 통과하기 전에는 HWP 대량 변환·대량 분석을 실행하지 않는다.

### 5. 출력 계약을 모델별로 분리

Anthropic용 JSON Schema와 Ollama용 JSON 모드를 같은 수준으로 취급하면 안 된다.

- 공통 내부 스키마는 유지한다.
- Anthropic provider는 JSON Schema를 사용한다.
- Ollama provider는 짧고 모델 친화적인 JSON 계약과 정규화 어댑터를 사용한다.
- Ollama 응답은 `provider`, `model`, `ollamaContext`, `inputChars`, `chunkIds`를 반드시 메타데이터에 기록한다.
- 키 누락, 영문 키, ID 형식 불일치는 검증 실패 또는 경고로 저장한다.

## 권장 다음 실험

아래처럼 작은 모델과 짧은 입력으로 안정성부터 확인한다.

```powershell
node analyze.js --provider ollama --model qwen3.5-hermes-2b-64k:latest --ollama-context 8192 --limit 1 --force
```

성공 기준은 단순 응답 생성이 아니라 다음 세 가지다.

1. Pass A가 ECR ID 전체를 반환한다.
2. Pass B가 Pass A의 모든 ID를 채운다.
3. `verifyExtraction`이 원문 발췌 대조까지 통과해 `verified: true`가 된다.

셋을 충족하지 못하면 결과는 뷰어에서 경고 상태로만 표시하고, 원문을 대신하지 않는다.
