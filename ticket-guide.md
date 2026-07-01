<!-- Synced from geneso goquest/guide/ticket-authoring-guide.md — edit there (source of truth), then re-sync. -->
# goquest 티켓 작성 가이드 (에이전트/MCP용)

goquest-mcp 도구로 티켓을 만들 때 따르는 규약. 정본은 이 문서이며, goquest-mcp 레포의 `ticket-guide.md`는 이 문서의 동기화 복사본이다.

## title_name 규약
- 정규식 `^[a-z][a-z0-9]*(-[a-z0-9]+)+$` — 소문자만, 하이픈 1개 이상 필수.
- 대문자(`GOQ-…`)나 하이픈 없는 단어는 422 거부.
- 형태: `<prefix>-<slug>`. prefix: goquest=`goq`, whoami=`who`, gopedia=`gop`, neunexus=`neunex`, infra=`infra`.
- 예: `goq-vault-portforward`, `who-render-contract`.

## 이름 기반 필드 우선
- `workspace`/`project`/`tag_names`로 지정한다 (UUID 불필요). 미존재 태그는 자동 생성(get-or-create).

## 관련 문서 링크 (ref_ids) — 필수
- 티켓을 만들 때 그 근거가 된 **설계/플랜/스펙 문서를 `ref_ids`로 반드시 링크**한다.
- 형식: `<소스>:<경로>` 또는 repo 상대경로. 예: `geneso:whoami/spec/whoami-ecosystem-design-direction.md`, `goquest-ios/docs/superpowers/plans/2026-06-01-contracts-approval.md`.
- **서브태스크는 부모의 `ref_ids`를 승계**한다 — Epic/부모에만 붙이고 서브태스크에 누락하지 않는다(일부만 링크되는 흔한 실수).
- 제약: 각 항목 512자 이하, 중복 불가. goquest는 존재 여부를 **검증하지 않으므로**(dangling 가능) 정확한 경로를 넣는다.
- `create_ticket`의 `ref_ids`는 생성 시 부착, `update_ticket`의 `ref_ids`는 **전체 집합으로 교체**(delta 아님).

## 멱등
- 같은 project 안에서 동일 `title_name`으로 create하면 기존 티켓이 반환된다(`replayed: true`). 재시도는 안전하다.

## dedup / parent 절차
1. 생성 전 `list_tickets`로 열린 티켓(status `pending`|`in_progress`) 조회.
2. 같은 태그 + 같은 `domain`의 티켓이 있으면 `parent_id`로 지정해 sub-ticket으로 만든다.
3. 없으면 `parent_id` 없이 new ticket.

## 상태머신
- `pending → assigned → in_progress → (pending_approval) → completed`.
- terminal: `completed`, `failed`, `cancelled` (추가 전이 불가).
- `pending → in_progress` 직행 불가 — 반드시 `assigned` 경유.

## 필드
- 필수: `title`. 권장: `title_name`, `project`(또는 `project_id`), `domain`, `ref_ids`(관련 문서).
- domain enum: `infra|data|code|monitor|knowledge|pm`.
- type enum: `task|bug|feature|incident|request`. priority: `urgent|high|normal|low`.

## git 연동 (VCS 자동 링크)
- 작업 branch는 **title_name을 포함**해 만든다 (예: `goq-foo` 또는 `feature/goq-foo`).
- PR 제목/본문·commit 메시지에도 title_name을 넣으면 해당 티켓에 자동 링크된다.
- 링크된 branch의 commit은 메시지에 title_name이 없어도 그 티켓에 상속된다.
- 자동 전이: branch 생성 / PR opened → in_progress, PR merged → completed(또는 repo 설정 pending_approval).
- 레포는 `register_vcs_repo`로 project에 1회 매핑해야 링크가 동작한다.
