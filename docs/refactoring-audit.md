# 리팩터링 1단계 — 읽기 전용 감사

저장소를 진단만 하고 **코드는 한 줄도 바꾸지 않는** 단계의 지시서다. 결과물은 보고서 하나다.
실제 정리는 [2단계](refactoring-cleanup.md)가 맡고, 2단계는 이 단계의 보고서를 입력으로 받는다.
2026-10-05에 이 지시서로 감사한 뒤 정리한 결과가 커밋 `010869f`다.

---

당신은 대규모 로컬 코드 저장소를 감사하는 시니어 소프트웨어 아키텍트이자 코드베이스 분석 에이전트다.

이 저장소는 오랜 기간 LLM 기반 바이브 코딩으로 빠르게 확장되었고, 구조적 일관성보다 개발 속도가 우선되었을 가능성이 높다.

이번 단계의 목적은 단 하나다.

**코드를 절대 수정하지 않고, 현재 저장소의 구조·위험·중복·복잡성·LLM 작업 적합성을 정확히 진단하는 것.**

중요:  
이 단계에서는 어떠한 코드 변경도 수행하지 않는다.

금지:

- 파일 수정
- 파일 삭제
- 파일 이동
- 파일명 변경
- dependency 변경
- formatting 실행
- migration 실행
- autofix 실행
- 코드 생성
- git commit
- git reset
- git checkout
- git clean
- destructive command

읽기와 분석만 수행한다.

---

# 1. 먼저 저장소 상태를 파악하라

다음부터 확인한다.

- git status
- repository root
- 주요 디렉터리
- package / dependency manifest
- build config
- test config
- lint / formatter config
- CI config
- environment 관련 파일
- migration
- scripts
- documentation

현재 working tree에 사용자가 작성 중인 변경이 있다면 반드시 기록한다.

그 변경은 이번 감사 대상과 분리해서 취급한다.

---

# 2. 전체 파일을 무작정 읽지 마라

LLM 컨텍스트를 효율적으로 사용하라.

다음 순서로 탐색한다.

1. 디렉터리 트리
2. 파일명
3. manifest / config
4. entry point
5. import / dependency 관계
6. 핵심 domain
7. 주요 service / controller / component
8. test
9. 문제가 의심되는 파일

처음부터 모든 파일 내용을 읽지 않는다.

큰 파일은 전체를 읽기 전에 다음을 먼저 본다.

- export
- import
- 주요 class / function
- public interface
- 호출 위치

---

# 3. 저장소 구조 지도를 만들어라

현재 구조를 요약한다.

예:

```
src/
  app/
  features/
  services/
  utils/
  database/
  components/
```

각 주요 디렉터리에 대해 기록한다.

- 책임
- 주요 기능
- 다른 영역에 대한 dependency
- public interface
- 잠재적인 구조 문제

특히 다음을 확인한다.

- domain 경계가 명확한가?
- feature가 여러 폴더에 흩어져 있는가?
- shared / common / utils가 과도하게 커졌는가?
- UI가 infrastructure에 직접 의존하는가?
- 서로 다른 layer가 뒤섞여 있는가?
- dependency 방향이 일정한가?

---

# 4. 핵심 실행 흐름을 파악하라

다음 흐름을 가능한 범위에서 추적한다.

- application bootstrap
- request → handler → service → DB
- UI → state → API
- authentication
- authorization
- background jobs
- external API integrations
- persistence
- caching
- event flow

전체 코드를 읽는 대신 대표적인 흐름 몇 개를 선택해 분석한다.

---

# 5. 문제를 우선순위별로 분류하라

모든 문제를 아래 기준으로 나눈다.

## P0 — 위험

실제 장애나 보안 문제로 이어질 수 있음.

예:

- secret 노출
- 데이터 손실 가능성
- authorization 오류
- broken runtime path
- 위험한 migration
- production deadlock / loop
- 잘못된 cache invalidation
- critical error swallowing

## P1 — 구조적 부채

향후 수정 비용이 크게 증가하는 문제.

예:

- god file
- feature 간 순환 dependency
- 동일 기능 여러 구현
- domain boundary 없음
- 지나치게 강한 coupling
- repository / service / UI 책임 혼재
- 중요한 로직이 scattered 되어 있음

## P2 — 유지보수성 문제

예:

- naming inconsistency
- duplicate types
- duplicate utilities
- 오래된 helper
- 과도한 any
- 불필요하게 복잡한 control flow
- magic values

## P3 — 미관 또는 저위험 문제

예:

- 사소한 formatting 차이
- 중요하지 않은 파일명 취향
- 기능과 무관한 stylistic inconsistency

P3는 이번 감사에서 크게 다루지 않는다.

---

# 6. 중복 구현을 찾아라

다음 영역을 집중적으로 확인한다.

- API client
- fetch wrapper
- authentication
- authorization
- validation
- error handling
- logging
- retry
- caching
- date handling
- formatting
- database access
- query building
- pagination
- DTO
- schema
- types
- modal
- form handling
- notification
- configuration

발견한 중복마다 기록한다.

- 파일 위치
- 어떤 구현들이 중복인지
- 차이가 무엇인지
- 어떤 구현을 canonical implementation으로 삼는 것이 좋은지
- 통합 시 위험 요소

아직 통합하지 않는다.

---

# 7. dead code 후보를 찾되 삭제하지 마라

찾을 항목:

- import되지 않는 파일
- 호출되지 않는 함수
- 사용되지 않는 component
- 사용되지 않는 type
- 사용되지 않는 dependency
- 오래된 experiment
- deprecated module
- backup file
- 임시 script
- dead feature flag

단, 단순 검색만으로 dead code라고 확정하지 않는다.

다음을 확인한다.

- dynamic import
- framework convention
- reflection
- plugin loading
- runtime path
- CLI usage
- build-time usage
- config reference

결과를 세 단계로 표시한다.

- 확실한 dead code
- 높은 확률
- 추가 확인 필요

---

# 8. 큰 파일과 god object를 찾는다

다음을 조사한다.

- 지나치게 큰 파일
- 너무 많은 export
- 너무 많은 responsibility
- 너무 많은 dependency
- 지나치게 긴 function
- deeply nested condition
- 하나의 class가 너무 많은 역할을 수행함

각 후보에 대해 기록한다.

- 현재 역할
- 분리 가능한 책임
- 예상 분리 단위
- 분리 위험도

줄 수만 보고 판단하지 않는다.

---

# 9. shared / utils / common을 감사하라

특히 다음 디렉터리를 집중적으로 확인한다.

- shared
- utils
- helpers
- common
- lib

각 항목을 다음으로 분류한다.

- 실제 범용 코드
- 특정 domain에 속해야 하는 코드
- 중복 코드
- deprecated 코드
- 책임이 불명확한 코드

`utils`가 사실상 아무 코드나 들어가는 장소가 되었는지 판단한다.

---

# 10. 타입 시스템을 감사하라

다음을 찾는다.

- 동일한 interface 중복
- 거의 동일한 type
- DB model / API DTO 혼용
- any
- unknown의 잘못된 사용
- 과도한 type assertion
- runtime validation 누락
- nullable 처리 불일치
- enum / constant 중복

가능하면 canonical type source 후보를 제안한다.

아직 변경하지 않는다.

---

# 11. dependency를 감사하라

package manifest와 실제 import를 비교한다.

다음을 분류한다.

- 사용 중
- 사용되지 않는 것으로 보임
- 중복 기능 제공
- 지나치게 무거움
- legacy
- devDependency / runtime dependency 분류 이상

dependency를 제거하지 않는다.

대신 제거 가능성과 위험도를 기록한다.

---

# 12. configuration을 감사하라

다음을 확인한다.

- env
- config
- constants
- feature flags
- build config
- runtime config

찾아야 할 문제:

- 동일 설정 여러 곳 정의
- hard-coded URL
- magic value
- 환경별 분기 중복
- config와 code 책임 혼재
- 사용되지 않는 env
- env 이름 불일치

---

# 13. 에러 처리를 감사하라

다음을 찾는다.

- 빈 catch
- console.log만 하고 종료
- 에러 무시
- 서로 다른 API error shape
- 에러를 지나치게 여러 번 wrapping
- 내부 오류 메시지 사용자 노출
- retry와 error handling 중복

현재 프로젝트의 사실상 표준 패턴이 무엇인지도 기록한다.

---

# 14. 테스트 상태를 평가하라

다음을 확인한다.

- unit
- integration
- e2e
- snapshot
- regression

다음 관점으로 분석한다.

- 핵심 business logic 테스트가 있는가?
- 리팩터링 전에 보호가 필요한 영역은 어디인가?
- flaky 가능성이 높은 테스트가 있는가?
- 테스트와 실제 구현이 함께 위치하는가?
- 사용되지 않는 테스트 helper가 있는가?

이번 단계에서는 테스트를 수정하지 않는다.

가능하면 읽기 전용 성격의 test command는 실행해도 된다.

단, snapshot update, autofix, DB 데이터 파괴 가능성이 있는 명령은 실행하지 않는다.

---

# 15. LLM 작업 적합성을 평가하라

이 저장소를 향후 LLM 에이전트가 수정한다고 가정한다.

다음을 평가한다.

## 탐색 가능성

- 파일명만 보고 역할을 알 수 있는가?
- 관련 파일을 쉽게 찾을 수 있는가?
- feature가 한곳에 모여 있는가?

## 컨텍스트 효율

- 한 작업에 너무 많은 파일을 읽어야 하는가?
- 핵심 로직이 여러 디렉터리에 흩어져 있는가?
- 큰 파일 하나에 지나치게 많은 책임이 있는가?

## 예측 가능성

- 비슷한 기능이 항상 비슷한 위치에 있는가?
- naming convention이 일정한가?
- dependency 방향이 명확한가?

## 로컬성

함께 수정되는 코드가 가까운 곳에 있는가?

## 문서화

다음이 존재하는가?

- [AGENTS.md](http://AGENTS.md)
- architecture docs
- development guide
- testing instructions

---

# 16. 리팩터링 위험도를 평가하라

각 주요 문제에 대해 다음을 평가한다.

- 기대 효과
- 변경 범위
- regression 위험
- 테스트 보호 수준
- 선행 작업 필요 여부

위험도:

- Low
- Medium
- High

---

# 17. 변경하지 말고 실행 계획만 만들어라

최종적으로 실제 정리 작업을 위한 단계별 계획을 작성한다.

예:

Phase 0

- 테스트 baseline 확보

Phase 1

- 확실한 dead code 제거
- unused dependency 정리

Phase 2

- duplicate utility 통합

Phase 3

- shared/utils 재배치

Phase 4

- 큰 파일 분리

Phase 5

- domain boundary 개선

Phase 6

- 문서 및 [AGENTS.md](http://AGENTS.md) 정리

각 작업은 가능한 한 독립적으로 검증 가능하게 만든다.

---

# 최종 출력 형식

반드시 아래 형식으로 결과를 작성한다.

# Executive Summary

저장소 상태를 10줄 이내로 요약.

# Repository Map

주요 디렉터리와 역할.

# Architecture

현재 실제 architecture와 dependency 흐름.

# Findings

## P0

## P1

## P2

## P3

각 finding에는 다음을 포함한다.

- 문제
- 관련 파일
- 영향
- 권장 조치
- 변경 위험도

# Duplicate Implementations

통합 후보.

# Dead Code Candidates

확실도와 함께 표시.

# Large / High-Complexity Files

분리 후보와 이유.

# Dependency Findings

# Type-System Findings

# Configuration Findings

# Testing Gaps

# LLM Readiness Assessment

다음 항목을 1~5점으로 평가한다.

- 탐색 가능성
- 구조 예측 가능성
- 파일 책임 명확성
- 컨텍스트 효율
- 테스트 안전성
- 문서화

# Recommended Target Structure

현재 프로젝트에 맞는 목표 구조를 제안한다.

억지로 새로운 architecture를 도입하지 않는다.

# Refactoring Plan

실제 실행 순서를 단계별로 작성한다.

각 단계에 다음을 포함한다.

- 목표
- 대상 파일
- 예상 변경 범위
- 위험
- 검증 방법

# Do Not Touch Yet

현 시점에서 건드리지 않는 것이 좋은 영역.

# Audit Conclusion

가장 먼저 해야 할 5개 작업을 우선순위대로 제시한다.

---

# 절대 원칙

이번 단계에서는 분석만 한다.

좋아 보인다는 이유만으로 코드 구조를 바꾸지 않는다.

실제 코드와 dependency를 근거로 판단한다.

모르면 추측하지 말고 "확인 필요"라고 명시한다.

이번 감사 결과는 다음 단계에서 실제 코드 정리를 수행하는 입력 자료가 되어야 한다.