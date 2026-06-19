# DevFlow Lean Examples

Use this file only when examples are needed. Do not load it by default.

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
  "repoContext": "Repo inspection summary goes here: affected mapper/helper/viewmodel/tests and related behaviors to preserve.",
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
  "repoContext": "Parent-level repo findings, shared architecture, target package, risks, and integration constraints.",
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
  "repoContext": "Child-specific repo findings and parent contract dependency.",
  "jiraKey": "QCA-3242",
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
