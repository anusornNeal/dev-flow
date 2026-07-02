# DevFlow Lean Examples

Use this file only when examples are needed. Do not load it by default.

## Bad vs good split example

Bad: one oversized implementation card hides independent work in a long checklist.

```text
Title: Add warranty badge on Job Detail
Status: todo
Checklist:
- Add API field.
- Update DTO.
- Update mapper.
- Update repository.
- Update ViewModel.
- Render badge in UI.
- Add mapper tests.
- Add UI tests.
- Verify end to end.
```

Why bad:
- It mixes backend/data, frontend/UI, and verification slices.
- It starts in `todo` without explicit execution intent.
- The checklist is doing the job that child cards should do.
- Parallel agents would conflict or over-edit shared files.

Good: create a backlog parent plus focused backlog children.

```text
Parent card:
- Status: backlog
- Category: general
- Owns requirement, child boundaries, shared contract, integration, and final verification.

Backend/data child:
- Status: backlog
- Category: backend
- Owns API/DTO/model/mapper/repository changes and mapper tests.

Frontend/UI child:
- Status: backlog
- Category: frontend
- Owns ViewModel/UI state, screen rendering, navigation/copy, and UI tests.

Verification child, only when large enough:
- Status: backlog
- Category: general
- Owns regression matrix, final integrated command, and manual scenarios.
```

## Bug fix card

```json
{
  "projectName": "dev-flow",
  "title": "[QCA-3393] Fix start-job button date enable rule on Job Detail",
  "description": "Fix the Job Detail primary action rule for accepted jobs. Current wrong behavior: the "เริ่มงาน" button enable/disable state is inverted against jobStartDate. Expected behavior: future jobStartDate disables the button; today or past jobStartDate enables it. Out of scope: do not change finish-job, upload-document, or quotation actions unless they share the same incorrect helper.",
  "status": "backlog",
  "priority": "high",
  "branch": "fix/qca-3393-start-job-button-date-rule",
  "category": "frontend",
  "tags": ["android", "my-jobs"],
  "targetFiles": [
    "JobStartActionDateRule.kt",
    "JobDetailActionMapping.kt",
    "JobDetailViewModel.kt",
    "JobStartActionDateRuleTest.kt",
    "JobDetailActionMappingTest.kt"
  ],
  "checklist": [
    {
      "id": "step-1",
      "text": "Confirm the current start-job enablement path used by Job Detail.",
      "completed": false
    },
    {
      "id": "step-2",
      "text": "Add regression tests for future, today, and past jobStartDate cases.",
      "completed": false
    },
    {
      "id": "step-3",
      "text": "Fix the date comparison so future dates disable the start button.",
      "completed": false
    },
    {
      "id": "step-4",
      "text": "Verify existing non-start-job primary actions are unchanged.",
      "completed": false
    }
  ],
  "effort": "medium",
  "model": "GPT-5.4 Mini",
  "agent": "Codex",
  "reasoning": "Bounded Android behavior fix with clear target files and regression tests.",
  "acceptanceCriteria": "- Start-job button is disabled when jobStartDate is after today.\n- Start-job button is enabled when jobStartDate is today.\n- Start-job button is enabled when jobStartDate is before today.\n- Existing non-start-job primary actions keep their current behavior.",
  "verification": "- Run targeted tests for JobStartActionDateRuleTest.\n- Run targeted tests for JobDetailActionMappingTest.\n- Manually verify Job Detail start-job button state for future, today, and past start dates.",
  "repoContext": "Implementation map:\n- File: JobStartActionDateRule.kt\n  Class/function: evaluateStartJobAvailability\n  Current behavior: accepted-job start date comparison can invert future/today/past enablement.\n  Expected change: make future jobStartDate disable start-job and today/past enable it.\n- File: JobDetailActionMapping.kt\n  Class/function: mapPrimaryAction\n  Current behavior: Job Detail primary action consumes the incorrect date rule.\n  Expected change: use the corrected helper without changing non-start-job actions.\n- File: JobStartActionDateRuleTest.kt\n  Class/function: future/today/past start-date cases\n  Current behavior: missing regression coverage for the inverted rule.\n  Expected change: add explicit future, today, and past cases.\n\nOut of scope:\n- Do not change finish-job, upload-document, or quotation actions unless they share the same incorrect helper.",
  "jiraKey": "QCA-3393",
  "repo": "https://github.com/org/repo",
  "sourceUrl": ""
}
```

## Parent orchestrator card

```json
{
  "projectName": "dev-flow",
  "title": "[QCA-3242] Foundation, merge, and review for Details tab update",
  "description": "Define the shared foundation for the Details tab update, split child work, and own final integration/review.",
  "status": "backlog",
  "priority": "medium",
  "branch": "qca-3242-details-tab-foundation",
  "category": "general",
  "tags": ["android", "foundation"],
  "targetFiles": [
    "JobDetailInfoTab.kt",
    "shared/AttachmentPreviewContract.kt (new)"
  ],
  "checklist": [
    {
      "id": "found-1",
      "text": "Confirm shared package and directory structure for child tasks.",
      "completed": false
    },
    {
      "id": "found-2",
      "text": "Define navigation and attachment preview/open/share contracts for child pages.",
      "completed": false
    },
    {
      "id": "found-3",
      "text": "Create child tasks with minimal target-file overlap.",
      "completed": false
    },
    {
      "id": "found-4",
      "text": "Review and merge child branches back into the foundation branch.",
      "completed": false
    },
    {
      "id": "found-5",
      "text": "Run final integrated verification for the full Details tab flow.",
      "completed": false
    }
  ],
  "effort": "high",
  "model": "GPT-5.4",
  "agent": "Codex",
  "reasoning": "Parent owns architecture, child boundaries, branch integration, and final verification.",
  "acceptanceCriteria": "- Child task boundaries are clear.\n- Shared contracts are defined.\n- Final merged flow satisfies the Jira requirement.\n- No child branch conflicts remain unresolved.",
  "verification": "- Inspect each child branch before merge.\n- Run targeted build/test commands.\n- Manually verify final full flow after merge.",
  "repoContext": "Implementation map:\n- File: JobDetailInfoTab.kt\n  Class/function: Details tab entry points\n  Current behavior: Details tab work spans multiple detail pages and shared attachment behavior.\n  Expected change: define child boundaries and shared contracts before implementation.\n- File: shared/AttachmentPreviewContract.kt (new)\n  Class/function: AttachmentPreviewContract\n  Current behavior: attachment open/share behavior is duplicated or undefined across child pages.\n  Expected change: define the shared contract for child implementation cards.\n\nChild boundaries:\n- Frontend child cards own individual screens/routes.\n- Backend/data child cards own API/model/mapper changes if needed.\n\nOut of scope:\n- Parent does not implement all child screens directly.",
  "jiraKey": "QCA-3242",
  "repo": "https://github.com/org/repo",
  "sourceUrl": ""
}
```

## Child card

```json
{
  "projectName": "dev-flow",
  "parentId": "parent-task-id",
  "title": "Create Site Info detail page with customer attachments",
  "description": "Create the Site Info detail page slice under the parent foundation branch using the shared navigation and attachment contract.",
  "status": "backlog",
  "priority": "medium",
  "branch": "qca-3242-details-tab-foundation/site-info-page",
  "category": "frontend",
  "tags": ["android", "site-info"],
  "targetFiles": [
    "site_info/JobSiteInfoRoute.kt (new)",
    "site_info/JobSiteInfoScreen.kt (new)"
  ],
  "checklist": [
    {
      "id": "child-1",
      "text": "Branch from the parent foundation branch.",
      "completed": false
    },
    {
      "id": "child-2",
      "text": "Create the Site Info route and screen under the agreed package.",
      "completed": false
    },
    {
      "id": "child-3",
      "text": "Wire the Details tab Site Info entry point to the new route.",
      "completed": false
    },
    {
      "id": "child-4",
      "text": "Reuse the parent-defined attachment preview/open/share contract.",
      "completed": false
    }
  ],
  "effort": "high",
  "model": "GPT-5.4",
  "agent": "Codex",
  "reasoning": "New page with navigation and attachment behavior. Must stay aligned with parent contract.",
  "acceptanceCriteria": "- Site Info detail page opens from the expected entry point.\n- Customer remark is displayed when present.\n- Attachments render correctly.\n- Shared preview/open/share behavior is reused.",
  "verification": "- Navigate from Job Detail Details tab to Site Info.\n- Verify normal, empty, and attachment cases.\n- Open/share supported attachment types.\n- Return to Job Detail without navigation issues.",
  "repoContext": "Implementation map:\n- File: site_info/JobSiteInfoRoute.kt (new)\n  Class/function: JobSiteInfoRoute\n  Current behavior: Site Info detail route does not exist under the parent Details tab contract.\n  Expected change: create the route using the parent-defined navigation contract.\n- File: site_info/JobSiteInfoScreen.kt (new)\n  Class/function: JobSiteInfoScreen\n  Current behavior: customer remark and attachments are not rendered on a dedicated Site Info detail page.\n  Expected change: render remark and attachments using the parent-defined preview/open/share contract.\n\nOut of scope:\n- Do not redefine the shared attachment contract in this child card.",
  "jiraKey": "QCA-3242",
  "repo": "https://github.com/org/repo",
  "sourceUrl": ""
}
```

## Atlas-assisted card

Use this only for architecture, onboarding, unclear targetFiles, or cross-module impact. Keep `get_repo_context_bundle` first, then use `get_project_atlas` for module boundaries and read order, and still read exact target files before editing.

```text
Reasoning: Repo context found the prompt service and task service paths. Project Atlas task-focused mode added an inferred read order across prompt templates, task context, and MCP contract files. Keep explicit targetFiles authoritative; inspect any Atlas-suggested extras before adding scope.
```

## Frontend/backend split from one Jira

Use this pattern when one Jira item needs both data contract work and UI work.

Parent:

```json
{
  "projectName": "dev-flow",
  "title": "[QCA-3500] Define contract and integration for warranty badge on Job Detail",
  "description": "Coordinate the warranty badge feature for Job Detail. Backend/data work provides the warranty eligibility field; frontend work renders the badge on Job Detail. Keep child work split so API/model changes can be tested independently from UI rendering.",
  "status": "backlog",
  "priority": "medium",
  "branch": "qca-3500-warranty-badge-foundation",
  "category": "general",
  "tags": ["android", "job-detail", "foundation"],
  "targetFiles": ["JobDetailWarrantyContract.kt (new)", "JobDetailResponse.kt", "JobDetailScreen.kt"],
  "checklist": [
    {
      "id": "split-1",
      "text": "Confirm backend/data and frontend child boundaries.",
      "completed": false
    },
    {
      "id": "split-2",
      "text": "Create backend/data and frontend child cards with minimal target-file overlap.",
      "completed": false
    },
    {
      "id": "split-3",
      "text": "Run final integrated verification after both children are complete.",
      "completed": false
    }
  ],
  "effort": "medium",
  "model": "GPT-5.4 Mini",
  "agent": "Codex",
  "reasoning": "One Jira spans data contract and UI rendering, so split into backend and frontend child cards.",
  "acceptanceCriteria": "- Backend/data and frontend child scopes are clear.\n- Integration behavior is verified after child work is merged.",
  "verification": "- Review child outputs.\n- Verify Job Detail shows the badge only when the backend/data contract says eligible.",
  "repoContext": "Implementation map:\n- File: JobDetailWarrantyContract.kt (new)\n  Class/function: JobDetailWarrantyContract\n  Current behavior: no shared contract describes warranty badge eligibility for child work.\n  Expected change: define the contract between backend/data and frontend child cards.\n- File: JobDetailResponse.kt\n  Class/function: warranty eligibility field\n  Current behavior: backend/data shape may not expose eligibility.\n  Expected change: backend child owns model/mapper/API handling.\n- File: JobDetailScreen.kt\n  Class/function: Job detail header/status area\n  Current behavior: UI does not render a warranty badge.\n  Expected change: frontend child owns rendering once data is available.\n\nOut of scope:\n- Parent does not implement backend or frontend child changes directly.",
  "jiraKey": "QCA-3500",
  "repo": "https://github.com/org/repo",
  "sourceUrl": ""
}
```

Backend child:

```json
{
  "projectName": "dev-flow",
  "parentId": "parent-task-id",
  "title": "Add warranty eligibility data mapping for Job Detail",
  "description": "Add the backend/data slice for the Job Detail warranty badge. Expose warranty eligibility through the existing Job Detail data path without changing UI rendering.",
  "status": "backlog",
  "priority": "medium",
  "branch": "qca-3500-warranty-badge-foundation/data-contract",
  "category": "backend",
  "tags": ["android", "job-detail", "data"],
  "targetFiles": ["JobDetailResponse.kt", "JobDetailMapper.kt", "JobDetailRepository.kt", "JobDetailMapperTest.kt"],
  "checklist": [
    {
      "id": "data-1",
      "text": "Confirm the existing Job Detail response/model/mapper path.",
      "completed": false
    },
    {
      "id": "data-2",
      "text": "Map warranty eligibility into the domain/UI model using the parent contract.",
      "completed": false
    },
    {
      "id": "data-3",
      "text": "Add mapper tests for eligible, not eligible, and missing-field cases.",
      "completed": false
    }
  ],
  "effort": "medium",
  "model": "GPT-5.4 Mini",
  "agent": "Codex",
  "reasoning": "Backend/data child can be verified with mapper/data tests without UI work.",
  "acceptanceCriteria": "- Warranty eligibility is available to Job Detail state.\n- Missing or false eligibility does not show as eligible.\n- Existing Job Detail fields remain unchanged.",
  "verification": "- Run targeted mapper/repository tests.\n- Confirm frontend files are not changed in this child.",
  "repoContext": "Implementation map:\n- File: JobDetailResponse.kt\n  Class/function: warranty eligibility DTO field\n  Current behavior: response model lacks or ignores warranty eligibility.\n  Expected change: add/confirm nullable-safe field handling.\n- File: JobDetailMapper.kt\n  Class/function: mapJobDetailResponse\n  Current behavior: domain/UI model does not receive warranty eligibility.\n  Expected change: map eligibility according to the parent contract.\n\nOut of scope:\n- Do not render the badge or edit JobDetailScreen.kt in this backend child.",
  "jiraKey": "QCA-3500",
  "repo": "https://github.com/org/repo",
  "sourceUrl": ""
}
```

Frontend child:

```json
{
  "projectName": "dev-flow",
  "parentId": "parent-task-id",
  "title": "Render warranty badge on Job Detail",
  "description": "Render the warranty badge on Job Detail using the eligibility value supplied by the backend/data child. Do not change API/model/mapper behavior in this frontend child.",
  "status": "backlog",
  "priority": "medium",
  "branch": "qca-3500-warranty-badge-foundation/ui-badge",
  "category": "frontend",
  "tags": ["android", "job-detail", "ui"],
  "targetFiles": ["JobDetailScreen.kt", "JobDetailViewModel.kt", "JobDetailScreenTest.kt"],
  "checklist": [
    {
      "id": "ui-1",
      "text": "Confirm where Job Detail header/status metadata is rendered.",
      "completed": false
    },
    {
      "id": "ui-2",
      "text": "Render the badge only when warranty eligibility is true.",
      "completed": false
    },
    {
      "id": "ui-3",
      "text": "Add UI/state tests for eligible and not eligible cases.",
      "completed": false
    }
  ],
  "effort": "medium",
  "model": "GPT-5.4 Mini",
  "agent": "Codex",
  "reasoning": "Frontend child can be implemented against the parent data contract and verified with UI/state tests.",
  "acceptanceCriteria": "- Badge appears only for eligible jobs.\n- Badge is absent for false or missing eligibility.\n- Existing Job Detail layout remains stable.",
  "verification": "- Run targeted Job Detail UI/state tests.\n- Manually verify eligible and not eligible Job Detail states.",
  "repoContext": "Implementation map:\n- File: JobDetailScreen.kt\n  Class/function: JobDetailHeader / status metadata area\n  Current behavior: no warranty badge is rendered.\n  Expected change: render the badge when eligibility is true.\n- File: JobDetailViewModel.kt\n  Class/function: Job Detail UI state mapping\n  Current behavior: UI state may not expose badge visibility.\n  Expected change: expose badge visibility from the parent contract value.\n\nOut of scope:\n- Do not edit API response, repository, or mapper files in this frontend child.",
  "jiraKey": "QCA-3500",
  "repo": "https://github.com/org/repo",
  "sourceUrl": ""
}
```

## Blocked/prep card

```json
{
  "projectName": "dev-flow",
  "title": "[QCA-0000] Blocked: clarify missing requirement for affected flow",
  "description": "This card preserves the request but is not implementation-ready because critical Jira or repo context is missing.",
  "status": "backlog",
  "priority": "medium",
  "branch": "",
  "category": "general",
  "tags": ["blocked"],
  "targetFiles": [],
  "checklist": [
    {
      "id": "blocked-1",
      "text": "Obtain the missing requirement, screenshot, attachment, or repo access needed to define implementation scope.",
      "completed": false
    },
    {
      "id": "blocked-2",
      "text": "Update this card with concrete description, repoContext, targetFiles, acceptanceCriteria, and verification before moving to todo.",
      "completed": false
    }
  ],
  "effort": "medium",
  "model": "GPT-5.4 Mini",
  "agent": "Codex",
  "reasoning": "Do not create implementation-ready work without confirmed requirement and repo context.",
  "acceptanceCriteria": "- Missing inputs are identified.\n- Card remains in backlog until implementation details are confirmed.",
  "verification": "- Confirm missing Jira/repo/spec/attachment details are available before converting to implementation card.",
  "repoContext": "Repo not inspected or insufficient to determine safe implementation scope.",
  "jiraKey": "QCA-0000",
  "repo": "",
  "sourceUrl": ""
}
```
