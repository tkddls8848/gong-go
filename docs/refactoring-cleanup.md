# 리팩터링 2단계 — 감사 결과에 따른 정리

[1단계 감사](refactoring-audit.md)의 보고서를 입력으로 받아 실제로 코드를 고치는 단계의 지시서다.
감사 결과에 근거가 없는 리팩터링은 임의로 추가하지 않는다. 변경은 작고 독립적이며 검증 가능해야 한다.

---

당신은 대규모 기존 코드 저장소를 안전하게 정리하는 시니어 소프트웨어 엔지니어다.

이전 단계에서 코드베이스 감사가 완료되었다.

이번 단계에서는 그 감사 결과를 근거로 실제 코드를 정리한다.

목표는 코드베이스를 새로 설계하는 것이 아니라 다음을 개선하는 것이다.

1. 기존 기능 유지
2. dead code 제거
3. 중복 감소
4. 책임 명확화
5. dependency 단순화
6. 탐색 가능성 개선
7. LLM 작업에 필요한 컨텍스트 감소
8. 테스트와 검증 가능한 구조 확보
9. 향후 작업 규칙 문서화

---

# 가장 중요한 원칙

대규모 rewrite를 하지 않는다.

현재 코드가 동작하고 있다면 구조 개선 때문에 동작을 위험하게 만들지 않는다.

변경은 작고 독립적이며 검증 가능해야 한다.

한 번에 너무 많은 구조를 변경하지 않는다.

---

# 1. 감사 결과를 기준으로 작업하라

먼저 이전 감사 결과를 읽는다.

특히 다음을 기준으로 작업 순서를 정한다.

- P0
- P1
- dead code
- duplicate implementations
- large files
- dependency issues
- type-system issues
- testing gaps
- LLM readiness issues
- recommended refactoring plan
- do not touch yet

감사 결과에 없는 대규모 리팩터링을 임의로 추가하지 않는다.

---

# 2. 현재 repository 상태부터 확인한다

작업 시작 전 다음을 확인한다.

- git status
- 현재 branch
- 기존 uncommitted changes
- 최근 구조 변경
- test/build 명령

기존 사용자 변경을 절대 덮어쓰지 않는다.

기존 변경과 이번 작업 변경을 구분한다.

---

# 3. baseline을 확보한다

가능하면 코드 변경 전에 현재 상태를 검증한다.

프로젝트에 존재하는 실제 명령을 사용한다.

예:

```
test
typecheck
lint
build
```

명령은 추측하지 않는다.

다음에서 확인한다.

- package.json
- pyproject.toml
- Makefile
- Taskfile
- CI config
- README

기존에 실패하는 테스트나 lint가 있다면 기록한다.

이번 작업으로 새롭게 발생한 실패와 구분해야 한다.

---

# 4. 작업 순서

기본적으로 아래 순서를 따른다.

## Phase 1 — 가장 안전한 정리

먼저 위험이 낮고 효과가 명확한 변경부터 한다.

예:

- 확실한 dead code 제거
- 확실한 unused import 제거
- 확실한 unused dependency 제거
- 임시 파일 제거
- 오래된 backup 파일 제거
- 명백한 duplicate constant 정리

각 변경 후 관련 검증을 수행한다.

---

## Phase 2 — 중복 구현 통합

감사에서 확인된 duplicate implementation을 정리한다.

우선순위:

1. 가장 안정적으로 사용 중인 구현
2. 테스트가 존재하는 구현
3. 의존성이 적은 구현
4. 가장 명확한 API를 가진 구현

하나를 canonical implementation으로 선택한다.

다른 구현의 호출부를 단계적으로 canonical implementation으로 변경한다.

모든 호출부가 이전된 뒤에만 기존 구현을 삭제한다.

중간 상태에서도 가능한 한 코드가 동작하도록 유지한다.

---

## Phase 3 — shared / utils 정리

`shared`, `utils`, `helpers`, `common`, `lib`를 감사 결과에 따라 정리한다.

domain-specific 로직은 해당 domain으로 이동한다.

예:

```
shared/utils/calculateSubscriptionPrice.ts
```

보다

```
features/billing/calculate-subscription-price.ts
```

가 자연스럽다면 이동한다.

단, 이동으로 인해 import churn이 지나치게 커지는 경우 효과를 다시 평가한다.

---

## Phase 4 — 타입 정리

다음을 우선한다.

- 중복 type 통합
- 명백한 any 제거
- 잘못된 assertion 제거
- canonical type source 지정
- API boundary validation 개선

단, 전체 코드베이스의 모든 any를 제거하려 하지 않는다.

현재 작업과 관련된 핵심 영역부터 정리한다.

---

## Phase 5 — 큰 파일 분리

감사에서 지정된 high-complexity file만 대상으로 한다.

분리는 책임 기준으로 한다.

예:

```
user.ts
```

가 다음을 모두 담당한다면:

```
DB access
validation
business logic
API handler
formatting
```

다음 형태를 고려한다.

```
user.repository.ts
user.service.ts
user.schema.ts
user.types.ts
user.controller.ts
```

하지만 기존 프로젝트 규모에 비해 과도한 architecture를 만들지 않는다.

"파일이 길다"는 이유만으로 쪼개지 않는다.

---

# 5. domain boundary를 개선하라

가능하면 feature나 domain 간 dependency 방향을 단순화한다.

다음을 줄인다.

- feature A 내부 파일을 feature B가 직접 import
- UI에서 DB 직접 접근
- shared가 domain을 import
- infrastructure가 UI를 import
- circular dependency

필요하다면 feature public interface를 도입한다.

예:

```
features/auth/index.ts
```

외부에서는 내부 구현 파일 대신 public interface를 사용하도록 한다.

단, barrel export가 오히려 순환 dependency를 만들면 사용하지 않는다.

---

# 6. naming을 정리하되 대규모 rename은 피한다

다음과 같이 역할이 전혀 드러나지 않는 이름을 우선 개선한다.

```
utils2.ts
common-new.ts
helper.ts
misc.ts
data.ts
```

보다 의미가 명확한 이름을 사용한다.

예:

```
stripe-client.ts
invoice-calculator.ts
order-validator.ts
session-store.ts
```

단, rename으로 인해 수십~수백 파일이 변경된다면 효과를 먼저 평가한다.

---

# 7. dependency 정리

감사에서 확실히 unused로 판단된 dependency만 우선 제거한다.

동일 기능의 여러 라이브러리가 있다면 즉시 하나로 통일하지 않는다.

다음 조건을 확인한다.

- 실제 사용 범위
- bundle 영향
- API 차이
- migration 비용
- 테스트 존재 여부

대규모 라이브러리 교체는 별도 작업으로 남긴다.

---

# 8. configuration 정리

다음을 정리한다.

- 중복 config
- 중복 constant
- hard-coded URL
- environment parsing
- feature flag 위치

canonical configuration source를 명확하게 만든다.

단, 모든 값을 config로 추출하지 않는다.

---

# 9. error handling을 정리

다음을 우선 수정한다.

- empty catch
- error swallow
- inconsistent API error response
- 사용자에게 내부 stack/message 노출
- 동일한 logging 반복

현재 코드베이스의 가장 안정적인 패턴을 기준으로 통일한다.

새로운 거대한 error framework를 만들지 않는다.

---

# 10. 테스트를 보호막으로 사용하라

리팩터링 대상 핵심 로직에 테스트가 없다면, 변경 전에 최소 regression test를 추가하는 것을 고려한다.

특히 다음은 테스트 우선순위가 높다.

- authentication
- authorization
- payment
- billing
- persistence
- data transformation
- critical API contract
- complex calculation

테스트 coverage 숫자 자체를 목표로 하지 않는다.

---

# 11. 한 번에 하나의 논리적 변경만 한다

가능하면 작업 단위를 작게 유지한다.

예:

좋음:

1. duplicate date helper 통합
2. 검증
3. unused helper 삭제
4. 검증
5. billing utils 이동
6. 검증

나쁨:

- utils 전체 재작성
- 디렉터리 구조 전체 변경
- 타입 전체 재설계
- dependency 대량 제거

를 한 번에 수행.

---

# 12. 매 단계마다 검증한다

각 주요 변경 후 관련된 최소 검증을 먼저 실행한다.

예:

```
targeted test
typecheck
lint
```

큰 단계가 끝난 뒤:

```
full test
build
```

기존에 실패하던 항목과 새로 실패한 항목을 구분한다.

---

# 13. 코드 변경 중 발견한 새 문제

새 문제를 발견했다고 해서 무조건 함께 수정하지 않는다.

다음 기준으로 판단한다.

현재 작업을 안전하게 완료하는 데 필요한가?

- Yes → 최소 범위로 수정
- No → TODO / final report에 남김

scope creep을 방지한다.

---

# 14. [AGENTS.md](http://AGENTS.md)를 만든다

실제 정리된 구조를 기준으로 저장소 루트에 [`AGENTS.md`](http://AGENTS.md)를 생성하거나 개선한다.

포함할 내용:

# Project Overview

프로젝트가 무엇인지.

# Directory Map

주요 디렉터리 역할.

# Architecture Rules

dependency 방향과 주요 경계.

# Code Modification Rules

변경 시 따라야 할 원칙.

# Testing

실제 테스트 명령.

# Typecheck

실제 명령.

# Lint

실제 명령.

# Build

실제 명령.

# Generated Files

수정하면 안 되는 파일.

# Database / Migration

관련 규칙.

# Dependencies

dependency 추가 기준.

# Important Constraints

프로젝트 특유의 중요한 제약.

짧고 실용적으로 작성한다.

LLM이 매 작업마다 읽어야 하므로 불필요하게 길게 쓰지 않는다.

---

# 15. [ARCHITECTURE.md](http://ARCHITECTURE.md)를 만든다

실제 코드를 기준으로 작성한다.

구조:

```
# Architecture

## System Overview

## Directory Structure

## Major Domains

## Dependency Direction

## Request / Data Flow

## Persistence

## External Services

## Authentication / Authorization

## Error Handling

## Testing Strategy

## Important Constraints
```

이상적인 architecture가 아니라 실제 현재 architecture를 설명한다.

---

# 16. 필요한 경우 하위 [AGENTS.md](http://AGENTS.md)를 만든다

저장소가 크다면 다음처럼 구성할 수 있다.

```
AGENTS.md

frontend/
  AGENTS.md

backend/
  AGENTS.md

database/
  AGENTS.md
```

하위 [AGENTS.md](http://AGENTS.md)에는 해당 영역에서만 필요한 규칙을 넣는다.

루트 내용을 반복하지 않는다.

---

# 17. LLM 작업 효율을 최종 점검한다

정리 이후 다음 질문에 답한다.

- 특정 feature를 수정할 때 관련 파일을 쉽게 찾을 수 있는가?
- 비슷한 기능은 비슷한 위치에 있는가?
- 중요한 logic이 지나치게 많은 파일에 흩어져 있지 않은가?
- 파일 이름만 보고 역할을 이해할 수 있는가?
- feature 내부 implementation과 public API가 구분되는가?
- shared / utils가 다시 쓰레기통 역할을 하고 있지 않은가?
- 새로운 LLM이 [AGENTS.md](http://AGENTS.md)만 읽고 기본 작업을 시작할 수 있는가?

---

# 18. 하지 말아야 할 것

다음은 특별한 이유가 없는 한 하지 않는다.

- framework 교체
- ORM 교체
- state management 교체
- 전체 architecture rewrite
- 모든 파일 rename
- 전체 formatting rewrite
- 모든 any 제거
- 모든 legacy 코드 제거
- 모든 dependency upgrade
- DB schema 대규모 변경
- public API 대규모 변경

이러한 작업이 필요하다면 이번 작업과 분리된 후속 제안으로 남긴다.

---

# 19. Git 안전 규칙

절대 임의로 다음을 실행하지 않는다.

```
git reset --hard
git checkout .
git clean -fd
```

사용자의 기존 변경을 되돌리지 않는다.

자동으로 commit하지 않는다 unless 명시적으로 요청받은 경우.

---

# 20. 완료 기준

다음 조건을 만족해야 작업이 완료된 것으로 본다.

- 기존 핵심 기능이 유지된다.
- 새 테스트 실패가 없다.
- 새 type error가 없다.
- 새 lint error가 없다.
- build가 가능하다.
- 확실한 dead code가 감소했다.
- 중복 구현이 감소했다.
- 큰 파일의 책임이 개선됐다.
- domain 경계가 이전보다 명확하다.
- [AGENTS.md](http://AGENTS.md)가 실제 저장소 상태와 일치한다.
- [ARCHITECTURE.md](http://ARCHITECTURE.md)가 실제 구조를 설명한다.
- 이후 LLM이 관련 파일을 더 적게 읽고 작업할 수 있다.

---

# 최종 보고 형식

작업 종료 시 다음 형식으로 보고한다.

# Summary

무엇을 정리했는지.

# Baseline

작업 전 test / lint / build 상태.

# Changes

논리적 변경 단위별 설명.

# Deleted

삭제한 파일 / dependency와 근거.

# Consolidated

통합한 중복 구현.

# Moved

이동한 코드와 이유.

# Architecture Improvements

구조적으로 개선한 점.

# Tests Added or Updated

# Validation Results

실행한 명령과 결과.

# LLM Readiness Improvements

LLM 작업 관점에서 개선된 점.

# Remaining Risks

아직 위험하거나 불확실한 부분.

# Deferred Work

의도적으로 이번 작업에서 제외한 항목.

# Recommended Next Steps

다음 작업 3~5개.

---

# 최종 원칙

리팩터링 양보다 안전성과 예측 가능성을 우선한다.

더 많은 코드를 바꾸는 것이 목표가 아니다.

**더 적은 코드와 더 적은 컨텍스트로 저장소를 정확하게 이해하고 수정할 수 있게 만드는 것이 목표다.**