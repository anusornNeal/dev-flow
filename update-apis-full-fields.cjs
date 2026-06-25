const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/components/JsonTemplateModal.tsx');
let content = fs.readFileSync(filePath, 'utf8');

const startStr = 'const apiGroups = [';
const startIdx = content.indexOf(startStr);
if (startIdx === -1) {
  console.log("Could not find startStr");
  process.exit(1);
}

const endStrPattern = 'const apiSpecsWithIds = apiGroups.flatMap(';
const endIdx = content.indexOf(endStrPattern);
if (endIdx === -1) {
  console.log("Could not find endStrPattern");
  process.exit(1);
}

const newApiGroupsCode = `const apiGroups = [
  {
    groupName: 'Tasks & Batch Operations',
    endpoints: [
      {
        method: 'GET',
        path: '/api/tasks',
        description: 'เรียกดูรายการการ์ดงาน (Tickets) ทั้งหมดในระบบ sandbox',
        response: 'JSON Array ของ Tasks ทั้งหมดแบบเต็มรูปแบบ',
        responseExample: \`[
  {
    "id": "spec-backend-101",
    "projectId": "proj-xyz789",
    "title": "Setup Authentication API with Bearer Tokens",
    "description": "Create the backend authentication endpoints.\\n\\nProblem: We lack secure token validation.",
    "status": "todo",
    "priority": "high",
    "category": "backend",
    "tags": ["security", "auth"],
    "branch": "feature/api-auth-backend",
    "targetFiles": [
      "src/controllers/authController.ts",
      "src/middlewares/authMiddleware.ts"
    ],
    "checklist": [
      {
        "id": "auth-1",
        "text": "Add Argon2 password verification logic in authController",
        "completed": false
      }
    ],
    "agent": "Codex",
    "model": "GPT-5.4",
    "effort": "medium",
    "reasoning": "Standard backend security implementation.",
    "acceptanceCriteria": "All protected API endpoints return 401 when missing a valid JWT.",
    "verification": "Run \\\`npm run test:auth\\\`",
    "repoContext": "Relies on the argon2 module",
    "jiraKey": "QCA-3314",
    "repo": "https://github.com/my-org/auth-service",
    "createdAt": "2026-06-19T00:00:00.000Z",
    "updatedAt": "2026-06-19T00:00:00.000Z"
  }
]\`,
        example: 'fetch(\\'/api/tasks\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/schema/task',
        description: 'ดึงโครงสร้าง JSON Schema ของข้อมูลการ์ดงาน (Task)',
        response: 'JSON Schema Definition Object',
        responseExample: \`{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["id", "title", "status"],
  "properties": {
    "id": { "type": "string" },
    "projectId": { "type": "string" },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "status": { "type": "string", "enum": ["todo", "in-progress", "done"] },
    "priority": { "type": "string", "enum": ["low", "medium", "high", "critical"] },
    "category": { "type": "string" },
    "tags": { "type": "array", "items": { "type": "string" } },
    "branch": { "type": "string" },
    "targetFiles": { "type": "array", "items": { "type": "string" } },
    "checklist": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "text": { "type": "string" },
          "completed": { "type": "boolean" }
        }
      }
    },
    "agent": { "type": "string" },
    "model": { "type": "string" },
    "effort": { "type": "string" },
    "reasoning": { "type": "string" },
    "acceptanceCriteria": { "type": "string" },
    "verification": { "type": "string" },
    "repoContext": { "type": "string" },
    "jiraKey": { "type": "string" },
    "repo": { "type": "string" }
  }
}\`,
        example: 'fetch(\\'/api/schema/task\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id',
        description: 'เรียกดูการ์ดงานชิ้นใดชิ้นหนึ่งด้วย ID พร้อมฟิลด์ทั้งหมด',
        response: 'JSON Object ของ Task แบบเต็มรูปแบบ',
        responseExample: \`{
  "id": "spec-backend-101",
  "projectId": "proj-xyz789",
  "title": "Setup Authentication API with Bearer Tokens",
  "description": "Create the backend authentication endpoints.\\n\\nProblem: We lack secure token validation.",
  "status": "todo",
  "priority": "high",
  "category": "backend",
  "tags": ["security", "auth"],
  "branch": "feature/api-auth-backend",
  "targetFiles": [
    "src/controllers/authController.ts",
    "src/middlewares/authMiddleware.ts"
  ],
  "checklist": [
    {
      "id": "auth-1",
      "text": "Add Argon2 password verification logic in authController",
      "completed": false
    }
  ],
  "agent": "Codex",
  "model": "GPT-5.4",
  "effort": "medium",
  "reasoning": "Standard backend security implementation.",
  "acceptanceCriteria": "All protected API endpoints return 401 when missing a valid JWT.",
  "verification": "Run \\\`npm run test:auth\\\`",
  "repoContext": "Relies on the argon2 module",
  "jiraKey": "QCA-3314",
  "repo": "https://github.com/my-org/auth-service",
  "createdAt": "2026-06-19T00:00:00.000Z",
  "updatedAt": "2026-06-19T00:00:00.000Z"
}\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101\\').then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks',
        description: 'สร้างตั๋วงานเดี่ยว หรือนำเข้าการ์ดแบบกลุ่ม (Bulk Import)',
        payload: \`{
  "projectId": "proj-xyz789",
  "tasks": [
    {
      "title": "Setup Authentication API",
      "description": "Implement authentication using JWT",
      "status": "todo",
      "priority": "high",
      "category": "backend",
      "tags": ["auth"]
    }
  ]
}\`,
        response: 'JSON Object แสดงสถิติจำนวน { success, createdCount, updatedCount, tasks }',
        responseExample: \`{
  "success": true,
  "createdCount": 1,
  "updatedCount": 0,
  "tasks": [
    {
      "id": "task-new123",
      "projectId": "proj-xyz789",
      "title": "Setup Authentication API",
      "description": "Implement authentication using JWT",
      "status": "todo",
      "priority": "high",
      "category": "backend",
      "tags": ["auth"],
      "branch": "",
      "targetFiles": [],
      "checklist": [],
      "agent": "",
      "model": "",
      "effort": "",
      "reasoning": "",
      "acceptanceCriteria": "",
      "verification": "",
      "repoContext": "",
      "jiraKey": "",
      "repo": "",
      "createdAt": "2026-06-19T00:00:00.000Z",
      "updatedAt": "2026-06-19T00:00:00.000Z"
    }
  ]
}\`,
        example: 'fetch(\\'/api/tasks\\', { method: \\'POST\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ projectId: \\'proj-xyz789\\', tasks: [{title: \\'New Task\\'}] }) }).then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/tasks',
        description: 'เขียนและอัปเดตบันทึกการ์ดงานพร้อมกันแบบกลุ่ม (Batch Upsert)',
        payload: \`{
  "projectId": "proj-xyz789",
  "tasks": [
    {
      "id": "spec-backend-101",
      "title": "Updated Task Title",
      "status": "in-progress"
    }
  ]
}\`,
        response: 'JSON Object ยืนยันสถานะการอัปเดตแบบกลุ่ม',
        responseExample: \`{
  "success": true,
  "createdCount": 0,
  "updatedCount": 1,
  "tasks": [
    {
      "id": "spec-backend-101",
      "projectId": "proj-xyz789",
      "title": "Updated Task Title",
      "status": "in-progress",
      "priority": "high",
      "category": "backend",
      "tags": ["security", "auth"],
      "branch": "feature/api-auth-backend",
      "targetFiles": [
        "src/controllers/authController.ts",
        "src/middlewares/authMiddleware.ts"
      ],
      "checklist": [
        {
          "id": "auth-1",
          "text": "Add Argon2 password verification logic in authController",
          "completed": false
        }
      ],
      "agent": "Codex",
      "model": "GPT-5.4",
      "effort": "medium",
      "reasoning": "Standard backend security implementation.",
      "acceptanceCriteria": "All protected API endpoints return 401 when missing a valid JWT.",
      "verification": "Run \\\`npm run test:auth\\\`",
      "repoContext": "Relies on the argon2 module",
      "jiraKey": "QCA-3314",
      "repo": "https://github.com/my-org/auth-service",
      "createdAt": "2026-06-19T00:00:00.000Z",
      "updatedAt": "2026-06-19T00:05:00.000Z"
    }
  ]
}\`,
        example: 'fetch(\\'/api/tasks\\', { method: \\'PUT\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ projectId: \\'proj-xyz789\\', tasks: [{id: \\'spec-backend-101\\', title: \\'Updated\\'}] }) }).then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/tasks/:id',
        description: 'อัปเดตข้อมูลย่อยของการ์ดงาน เช่น เปลี่ยนสถานะเลน, แก้ไข checklist',
        payload: \`{
  "status": "in-progress",
  "priority": "critical",
  "checklist": [
    {
      "id": "auth-1",
      "text": "Add Argon2 logic",
      "completed": true
    }
  ]
}\`,
        response: 'JSON Object ของ Task ที่ผ่านการอัปเดตเรียบร้อย แบบเต็มรูปแบบ',
        responseExample: \`{
  "id": "spec-backend-101",
  "projectId": "proj-xyz789",
  "title": "Setup Authentication API with Bearer Tokens",
  "description": "Create the backend authentication endpoints.\\n\\nProblem: We lack secure token validation.",
  "status": "in-progress",
  "priority": "critical",
  "category": "backend",
  "tags": ["security", "auth"],
  "branch": "feature/api-auth-backend",
  "targetFiles": [
    "src/controllers/authController.ts",
    "src/middlewares/authMiddleware.ts"
  ],
  "checklist": [
    {
      "id": "auth-1",
      "text": "Add Argon2 logic",
      "completed": true
    }
  ],
  "agent": "Codex",
  "model": "GPT-5.4",
  "effort": "medium",
  "reasoning": "Standard backend security implementation.",
  "acceptanceCriteria": "All protected API endpoints return 401 when missing a valid JWT.",
  "verification": "Run \\\`npm run test:auth\\\`",
  "repoContext": "Relies on the argon2 module",
  "jiraKey": "QCA-3314",
  "repo": "https://github.com/my-org/auth-service",
  "createdAt": "2026-06-19T00:00:00.000Z",
  "updatedAt": "2026-06-19T00:05:00.000Z"
}\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101\\', { method: \\'PUT\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ status: \\'in-progress\\' }) }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/tasks/:id',
        description: 'ลบการ์ดงานชิ้นนั้นๆ อ้างอิงจาก ID อย่างถาวร',
        response: 'JSON Object ยืนยันการลบ พร้อมข้อมูล Task ที่ถูกลบ',
        responseExample: \`{
  "success": true,
  "removed": {
    "id": "spec-backend-101",
    "projectId": "proj-xyz789",
    "title": "Setup Authentication API with Bearer Tokens",
    "status": "todo"
  }
}\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101\\', { method: \\'DELETE\\' }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/batch',
        description: 'อัปเดตและสร้างบันทึกการ์ดงานพร้อมกันแบบกลุ่ม',
        payload: \`{
  "projectId": "proj-xyz789",
  "tasks": [
    { "id": "task-1", "status": "in-progress" },
    { "id": "task-2", "status": "done" }
  ]
}\`,
        response: 'JSON Object แสดงจำนวนที่อัปเดต',
        responseExample: \`{
  "success": true,
  "updatedCount": 2,
  "tasks": [
    { "id": "task-1", "status": "in-progress", "title": "Task 1", "projectId": "proj-xyz789" },
    { "id": "task-2", "status": "done", "title": "Task 2", "projectId": "proj-xyz789" }
  ]
}\`,
        example: 'fetch(\\'/api/tasks/batch\\', { method: \\'POST\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ projectId: \\'proj-xyz789\\', tasks: [{id: \\'task-1\\', status: \\'in-progress\\'}] }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/batch/move',
        description: 'ย้ายสถานะเลนการทำงานของการ์ดแบบกลุ่ม',
        payload: \`{
  "taskIds": ["spec-backend-101", "spec-frontend-102"],
  "status": "done"
}\`,
        response: 'JSON Object ยืนยันการทำงาน',
        responseExample: \`{
  "success": true,
  "updatedCount": 2,
  "updatedTasks": [
    {
      "id": "spec-backend-101",
      "title": "Setup Authentication API",
      "status": "done"
    },
    {
      "id": "spec-frontend-102",
      "title": "Store Authentication JWT",
      "status": "done"
    }
  ]
}\`,
        example: 'fetch(\\'/api/tasks/batch/move\\', { method: \\'POST\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ taskIds: [\\'spec-backend-101\\'], status: \\'done\\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/batch/checklist/toggle',
        description: 'สลับสถานะความสำเร็จของข้อกำหนด Checklist แบบกลุ่ม',
        payload: \`{
  "taskIds": ["spec-backend-101", "spec-frontend-102"],
  "checklistId": "auth-1"
}\`,
        response: 'JSON Object ยืนยันการทำงาน',
        responseExample: \`{
  "success": true,
  "updatedCount": 2
}\`,
        example: 'fetch(\\'/api/tasks/batch/checklist/toggle\\', { method: \\'POST\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ taskIds: [\\'spec-backend-101\\'], checklistId: \\'auth-1\\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/batch/assign',
        description: 'มอบหมาย Agent แบบกลุ่ม',
        payload: \`{
  "taskIds": ["spec-backend-101", "spec-frontend-102"],
  "agent": "Antigravity"
}\`,
        response: 'JSON Object ยืนยันการทำงาน',
        responseExample: \`{
  "success": true,
  "updatedCount": 2
}\`,
        example: 'fetch(\\'/api/tasks/batch/assign\\', { method: \\'POST\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ taskIds: [\\'spec-backend-101\\'], agent: \\'Antigravity\\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/move',
        description: 'ย้ายสถานะเลนการทำงานของการ์ดชิ้นหนึ่งๆ',
        payload: \`{
  "status": "done"
}\`,
        response: 'JSON Object สถานะตอบกลับ แบบเต็มรูปแบบ',
        responseExample: \`{
  "success": true,
  "task": {
    "id": "spec-backend-101",
    "projectId": "proj-xyz789",
    "title": "Setup Authentication API with Bearer Tokens",
    "description": "Create the backend authentication endpoints.\\n\\nProblem: We lack secure token validation.",
    "status": "done",
    "priority": "high",
    "category": "backend",
    "tags": ["security", "auth"],
    "branch": "feature/api-auth-backend",
    "targetFiles": [
      "src/controllers/authController.ts",
      "src/middlewares/authMiddleware.ts"
    ],
    "checklist": [
      {
        "id": "auth-1",
        "text": "Add Argon2 logic",
        "completed": true
      }
    ],
    "agent": "Codex",
    "model": "GPT-5.4",
    "effort": "medium",
    "reasoning": "Standard backend security implementation.",
    "acceptanceCriteria": "All protected API endpoints return 401 when missing a valid JWT.",
    "verification": "Run \\\`npm run test:auth\\\`",
    "repoContext": "Relies on the argon2 module",
    "jiraKey": "QCA-3314",
    "repo": "https://github.com/my-org/auth-service",
    "createdAt": "2026-06-19T00:00:00.000Z",
    "updatedAt": "2026-06-19T00:10:00.000Z"
  }
}\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101/move\\', { method: \\'POST\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ status: \\'done\\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/checklist/toggle',
        description: 'สลับสถานะความสำเร็จของข้อกำหนด Checklist item ภายใน Task เดียว',
        payload: \`{
  "checklistId": "auth-1"
}\`,
        response: 'JSON Object ยืนยันการทำงาน',
        responseExample: \`{
  "success": true,
  "task": {
    "id": "spec-backend-101",
    "title": "Setup Authentication API",
    "status": "todo",
    "checklist": [
      {
        "id": "auth-1",
        "text": "Add Argon2 logic",
        "completed": true
      }
    ]
  }
}\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101/checklist/toggle\\', { method: \\'POST\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ checklistId: \\'auth-1\\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/assign',
        description: 'มอบหมาย Agent สำหรับ Task เดียว',
        payload: \`{
  "agent": "Antigravity"
}\`,
        response: 'JSON Object ยืนยันการทำงาน',
        responseExample: \`{
  "success": true,
  "task": {
    "id": "spec-backend-101",
    "title": "Setup Authentication API",
    "agent": "Antigravity"
  }
}\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101/assign\\', { method: \\'POST\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ agent: \\'Codex\\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/import-file',
        description: 'นำเข้าตั๋วงานจากไฟล์ .json หรือ .md',
        payload: 'FormData (multipart/form-data) บรรจุไฟล์ (key: "file")',
        response: 'JSON Object แสดงจำนวนที่ถูก import พร้อมข้อมูล Tasks อย่างละเอียด',
        responseExample: \`{
  "success": true,
  "createdCount": 5,
  "updatedCount": 0,
  "tasks": [
    {
      "id": "task-imported-1",
      "projectId": "proj-xyz789",
      "title": "Imported Task",
      "description": "Details from file",
      "status": "todo",
      "priority": "low",
      "category": "frontend",
      "tags": ["import"],
      "branch": "",
      "targetFiles": [],
      "checklist": [],
      "agent": "",
      "model": "",
      "effort": "",
      "reasoning": "",
      "acceptanceCriteria": "",
      "verification": "",
      "repoContext": "",
      "jiraKey": "",
      "repo": "",
      "createdAt": "2026-06-19T00:00:00.000Z",
      "updatedAt": "2026-06-19T00:00:00.000Z"
    }
  ]
}\`,
        example: 'const formData = new FormData();\\nformData.append("file", fileBlob);\\nfetch(\\'/api/tasks/import-file\\', { method: \\'POST\\', body: formData }).then(res => res.json());'
      }
    ]
  },
  {
    groupName: 'Agent & Prompts',
    endpoints: [
      {
        method: 'GET',
        path: '/api/tasks/:id/prompt',
        description: 'ดึงข้อมูล Prompt พื้นฐานหรือ System Prompt สำหรับการ์ดงานนี้เพื่อส่งให้ AI',
        response: 'JSON Object บรรจุ String ของ Prompt อย่างละเอียด',
        responseExample: \`{
  "prompt": "You are Antigravity, a powerful agentic AI coding assistant...\\n\\nThe user wants you to implement the following task:\\n\\nTask: Setup Authentication API with Bearer Tokens\\nDescription: Create the backend authentication endpoints...\\n\\nChecklist:\\n[ ] Add Argon2 logic\\n"
}\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101/prompt\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id/agent-context',
        description: 'ดึงข้อมูล Context ล่าสุดเพื่อเตรียมรัน Agent แบบครอบคลุม',
        response: 'JSON Object ของ Context',
        responseExample: \`{
  "taskId": "spec-backend-101",
  "projectPath": "/Users/developer/Projects/auth-service",
  "repoUrl": "https://github.com/my-org/auth-service",
  "branch": "feature/api-auth-backend",
  "systemInfo": {
    "os": "darwin",
    "arch": "arm64",
    "nodeVersion": "v20.10.0"
  },
  "agentConfig": {
    "agentName": "Codex",
    "model": "GPT-5.4",
    "maxIterations": 20
  },
  "targetFiles": [
    "src/controllers/authController.ts",
    "src/middlewares/authMiddleware.ts"
  ]
}\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101/agent-context\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id/agent-runs',
        description: 'ดึงประวัติการรัน Agent ทั้งหมดของ Task',
        response: 'JSON Array แสดงประวัติการรันอย่างละเอียด',
        responseExample: \`[
  {
    "id": "run-f1a2b3c4",
    "taskId": "spec-backend-101",
    "agent": "Codex",
    "model": "GPT-5.4",
    "status": "completed",
    "startedAt": "2026-06-19T00:00:00.000Z",
    "finishedAt": "2026-06-19T00:05:00.000Z",
    "durationMs": 300000,
    "totalTokens": 15000,
    "errorReason": null
  }
]\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101/agent-runs\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id/agent-runs/:runId/history',
        description: 'ดึงประวัติการสนทนาและ Message History ของการรัน Agent',
        response: 'JSON Array ของ Messages',
        responseExample: \`[
  {
    "role": "system",
    "content": "You are Antigravity...",
    "timestamp": "2026-06-19T00:00:00.000Z"
  },
  {
    "role": "user",
    "content": "Please implement the task.",
    "timestamp": "2026-06-19T00:00:01.000Z"
  },
  {
    "role": "assistant",
    "content": "I will begin by creating the authController.",
    "toolCalls": [
      {
        "name": "write_to_file",
        "arguments": { "TargetFile": "src/controllers/authController.ts" }
      }
    ],
    "timestamp": "2026-06-19T00:00:10.000Z"
  }
]\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101/agent-runs/run-1/history\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id/agent-runs/:runId/log',
        description: 'ดึงข้อมูลบันทึกการทำงาน (Log) ของ Agent ที่รันผ่าน Task นี้แบบดิบ (Raw Text)',
        response: 'Text String แสดง Log การทำงานแบบหลายบรรทัด',
        responseExample: \`[2026-06-19T00:00:00.000Z] [INFO] Agent started processing task DVF-0001
[2026-06-19T00:00:02.000Z] [INFO] Loaded context and repository schema
[2026-06-19T00:00:10.000Z] [TOOL] Executing write_to_file...
[2026-06-19T00:05:00.000Z] [SUCCESS] Agent marked task as complete\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101/agent-runs/run-123/log\\').then(res => res.text());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/agent-runs/retry',
        description: 'สั่ง Retry การรัน Agent ที่ล้มเหลว หรือถูกยกเลิก',
        response: 'JSON Object สถานะของการเริ่มใหม่',
        responseExample: \`{
  "success": true,
  "newRunId": "run-e5f6g7h8",
  "status": "running"
}\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101/agent-runs/retry\\', { method: \\'POST\\' }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/agent-runs/cancel',
        description: 'สั่ง Cancel การรัน Agent ปัจจุบัน',
        response: 'JSON Object สถานะการยกเลิก',
        responseExample: \`{
  "success": true,
  "cancelledRunId": "run-e5f6g7h8",
  "status": "cancelled"
}\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101/agent-runs/cancel\\', { method: \\'POST\\' }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/agent-complete',
        description: 'แจ้งสถานะ Complete จากตัว Agent โดยตรงเพื่ออัปเดต Task',
        payload: \`{
  "status": "success",
  "summary": "Finished UI and fixed all tests",
  "completedChecklistIds": ["auth-1"]
}\`,
        response: 'JSON Object ยืนยัน',
        responseExample: \`{
  "success": true,
  "updatedTask": {
    "id": "spec-backend-101",
    "status": "done"
  }
}\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101/agent-complete\\', { method: \\'POST\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ status: \\'success\\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/agent-runs/:runId/complete',
        description: 'แจ้งสถานะ Complete ระบุตาม Run ID (เฉพาะเจาะจงเจาะลึก)',
        payload: \`{
  "status": "success",
  "artifacts": ["docs/agent-tasks/result.md"]
}\`,
        response: 'JSON Object ยืนยัน',
        responseExample: \`{
  "success": true,
  "runId": "run-f1a2b3c4"
}\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101/agent-runs/run-1/complete\\', { method: \\'POST\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ status: \\'success\\' }) }).then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/prompt-template/sections',
        description: 'ดึงหัวข้อ Prompt Template ทั้งหมด',
        response: 'JSON Array แบบเต็ม',
        responseExample: \`[
  {
    "id": "sys-prompt",
    "name": "System Identity",
    "content": "You are Antigravity...",
    "isRequired": true,
    "order": 0
  },
  {
    "id": "task-details",
    "name": "Task Specification",
    "content": "Here is the task: {{task.title}}",
    "isRequired": true,
    "order": 1
  }
]\`,
        example: 'fetch(\\'/api/prompt-template/sections\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/prompt-template/section',
        description: 'ดึงเนื้อหา Prompt Template ล่าสุดตาม Section ID',
        response: 'JSON Object รายละเอียดของ 1 Section',
        responseExample: \`{
  "id": "sys-prompt",
  "name": "System Identity",
  "content": "You are Antigravity...",
  "isRequired": true,
  "order": 0
}\`,
        example: 'fetch(\\'/api/prompt-template/section?id=sys-prompt\\').then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/prompt-template/section',
        description: 'อัปเดตเนื้อหา Prompt Template',
        payload: \`{
  "id": "sys-prompt",
  "content": "You are Antigravity, an elite agent..."
}\`,
        response: 'JSON Object ยืนยันอัปเดต',
        responseExample: \`{
  "success": true,
  "updatedSection": {
    "id": "sys-prompt",
    "content": "You are Antigravity, an elite agent..."
  }
}\`,
        example: 'fetch(\\'/api/prompt-template/section\\', { method: \\'PUT\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ id: \\'sys-prompt\\', content: \\'hi\\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/prompt-template/preview',
        description: 'ดูตัวอย่างผลลัพธ์ของ Prompt (Preview) พร้อมแทนที่ตัวแปร (Variables)',
        payload: \`{
  "template": "Task: {{title}}",
  "variables": { "title": "Setup API" }
}\`,
        response: 'JSON Object แสดงพรีวิว',
        responseExample: \`{
  "preview": "Task: Setup API"
}\`,
        example: 'fetch(\\'/api/prompt-template/preview\\', { method: \\'POST\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ template: \\'Task: {{title}}\\', variables: {title: \\'Test\\'} }) }).then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/prompt-overrides/sections',
        description: 'ดึงข้อมูล Overrides ของ Prompt ที่ถูกกำหนดทับค่าปกติ',
        response: 'JSON Array ของ Overrides',
        responseExample: \`[
  {
    "projectId": "proj-xyz789",
    "sectionId": "sys-prompt",
    "overrideContent": "You are a backend specific agent."
  }
]\`,
        example: 'fetch(\\'/api/prompt-overrides/sections\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/prompt-overrides/section',
        description: 'ดึง override ของ section หนึ่ง',
        response: 'JSON Object',
        responseExample: \`{
  "projectId": "proj-xyz789",
  "sectionId": "sys-prompt",
  "overrideContent": "You are a backend specific agent."
}\`,
        example: 'fetch(\\'/api/prompt-overrides/section?id=sys-prompt\\').then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/prompt-overrides/section',
        description: 'อัปเดต override ของ section หนึ่ง',
        payload: \`{
  "id": "sys-prompt",
  "projectId": "proj-xyz789",
  "overrideContent": "New specialized agent prompt"
}\`,
        response: 'JSON Object',
        responseExample: \`{
  "success": true,
  "override": {
    "sectionId": "sys-prompt",
    "overrideContent": "New specialized agent prompt"
  }
}\`,
        example: 'fetch(\\'/api/prompt-overrides/section\\', { method: \\'PUT\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ id: \\'sys-prompt\\', overrideContent: \\'...\\' }) }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/prompt-overrides/section',
        description: 'ลบ override เพื่อกลับไปใช้ค่า Default',
        response: 'JSON Object',
        responseExample: \`{
  "success": true,
  "deletedSectionId": "sys-prompt"
}\`,
        example: 'fetch(\\'/api/prompt-overrides/section?id=sys-prompt\\', { method: \\'DELETE\\' }).then(res => res.json());'
      }
    ]
  },
  {
    groupName: 'Projects',
    endpoints: [
      {
        method: 'GET',
        path: '/api/projects',
        description: 'เรียกดูรายการโปรเจกต์ทั้งหมดในระบบแบบเต็ม',
        response: 'JSON Array ของ Projects ทั้งหมด',
        responseExample: \`[
  {
    "id": "proj-xyz789",
    "name": "DevFlow Sandbox",
    "repoUrl": "https://github.com/my/dev-flow-sandbox",
    "description": "Sandbox project for testing DevFlow API",
    "localPath": "/Users/developer/Projects/dev-flow-sandbox",
    "taskIdPrefix": "DVF",
    "createdAt": "2024-03-10T12:00:00.000Z"
  }
]\`,
        example: 'fetch(\\'/api/projects\\').then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/projects',
        description: 'สร้างโปรเจกต์ใหม่เพื่อใช้ผูกกับการ์ดงาน',
        payload: \`{
  "name": "Authentication Microservice",
  "repoUrl": "https://github.com/my/auth-service",
  "description": "Handles user login and JWT generation",
  "localPath": "/Users/dev/auth-service",
  "taskIdPrefix": "AUTH"
}\`,
        response: 'JSON Object ของ Project ที่สร้างเสร็จ แบบเต็ม',
        responseExample: \`{
  "id": "proj-abc123",
  "name": "Authentication Microservice",
  "repoUrl": "https://github.com/my/auth-service",
  "description": "Handles user login and JWT generation",
  "localPath": "/Users/dev/auth-service",
  "taskIdPrefix": "AUTH",
  "createdAt": "2026-06-19T00:00:00.000Z"
}\`,
        example: 'fetch(\\'/api/projects\\', { method: \\'POST\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ name: \\'Test\\', repoUrl: \\'http://\\' }) }).then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/projects/:id',
        description: 'อัปเดตข้อมูลโปรเจกต์ เช่น เปลี่ยนชื่อ หรือ URL แบบเต็ม',
        payload: \`{
  "name": "Auth Service V2",
  "taskIdPrefix": "AUTHV2"
}\`,
        response: 'JSON Object ของ Project ที่อัปเดตเสร็จ',
        responseExample: \`{
  "id": "proj-abc123",
  "name": "Auth Service V2",
  "repoUrl": "https://github.com/my/auth-service",
  "description": "Handles user login and JWT generation",
  "localPath": "/Users/dev/auth-service",
  "taskIdPrefix": "AUTHV2",
  "createdAt": "2026-06-19T00:00:00.000Z",
  "updatedAt": "2026-06-19T00:10:00.000Z"
}\`,
        example: 'fetch(\\'/api/projects/proj-abc123\\', { method: \\'PUT\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ name: \\'Auth V2\\' }) }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/projects',
        description: 'ลบข้อมูล Project แบบกลุ่ม',
        response: 'JSON Object',
        responseExample: \`{
  "success": true,
  "deletedCount": 3
}\`,
        example: 'fetch(\\'/api/projects\\', { method: \\'DELETE\\' }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/projects/:id',
        description: 'ลบโปรเจกต์พร้อมตั๋วงานที่ผูกกับโปรเจกต์นั้นอย่างถาวร',
        response: '{ "success": true, "removedId": "project-id" }',
        responseExample: \`{
  "success": true,
  "removedId": "proj-xyz789",
  "deletedTasksCount": 15
}\`,
        example: 'fetch(\\'/api/projects/proj-abc123\\', { method: \\'DELETE\\' }).then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/projects/:id/prompt-sections',
        description: 'ดึง Prompt Sections ที่ตั้งค่า override สำหรับ Project หนึ่ง',
        response: 'JSON Array ของ overrides',
        responseExample: \`[
  {
    "sectionId": "sys-prompt",
    "overrideContent": "Project specific instructions here."
  }
]\`,
        example: 'fetch(\\'/api/projects/proj-abc123/prompt-sections\\').then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/projects/:id/prompt-overrides/:sectionId',
        description: 'อัปเดต Prompt Override ของ Project เฉพาะ',
        payload: \`{ "content": "You must use TypeScript strictly." }\`,
        response: 'JSON Object',
        responseExample: \`{
  "success": true,
  "override": {
    "sectionId": "sys-prompt",
    "content": "You must use TypeScript strictly."
  }
}\`,
        example: 'fetch(\\'/api/projects/proj-abc123/prompt-overrides/sys-prompt\\', { method: \\'PUT\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ content: \\'hi\\' }) }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/projects/:id/prompt-overrides/:sectionId',
        description: 'ลบ Prompt Override ของ Project เฉพาะ',
        response: 'JSON Object',
        responseExample: \`{
  "success": true,
  "deletedSectionId": "sys-prompt"
}\`,
        example: 'fetch(\\'/api/projects/proj-abc123/prompt-overrides/sys-prompt\\', { method: \\'DELETE\\' }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/projects/:id/prompt-preview',
        description: 'Preview Prompt ภายในบริบทของ Project (แทนที่ตัวแปร)',
        payload: \`{ "variables": { "projectName": "Auth V2" } }\`,
        response: 'JSON Object',
        responseExample: \`{
  "preview": "Welcome to Auth V2 project prompt preview..."
}\`,
        example: 'fetch(\\'/api/projects/proj-abc123/prompt-preview\\', { method: \\'POST\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ variables: {} }) }).then(res => res.json());'
      }
    ]
  },
  {
    groupName: 'Skills',
    endpoints: [
      {
        method: 'GET',
        path: '/api/skills',
        description: 'ดึงรายการ Skills ทั้งหมดแบบเต็มรูปแบบ',
        response: 'JSON Array',
        responseExample: \`[
  {
    "id": "react-skill-001",
    "name": "React Hooks Master",
    "description": "Skill for writing optimized React Hooks and functional components",
    "author": "DevFlow Community",
    "version": "1.0.2",
    "repository": "https://github.com/skills/react-hooks",
    "instructions": "When writing React, always use useMemo for heavy calculations...",
    "createdAt": "2026-06-19T00:00:00.000Z"
  }
]\`,
        example: 'fetch(\\'/api/skills\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/skills/authoring',
        description: 'ดึงรายการ Authoring Skills (ผู้แต่ง)',
        response: 'JSON Array',
        responseExample: \`[
  {
    "id": "my-custom-skill-1",
    "name": "Company Custom Auth",
    "isAuthor": true,
    "localPath": "/Users/dev/.skills/custom-auth"
  }
]\`,
        example: 'fetch(\\'/api/skills/authoring\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/skills/:id',
        description: 'ดึงรายละเอียด Skill ด้วย ID',
        response: 'JSON Object ของ 1 Skill',
        responseExample: \`{
  "id": "react-skill-001",
  "name": "React Hooks Master",
  "description": "Skill for writing optimized React Hooks and functional components",
  "author": "DevFlow Community",
  "version": "1.0.2",
  "repository": "https://github.com/skills/react-hooks",
  "instructions": "When writing React, always use useMemo for heavy calculations...",
  "createdAt": "2026-06-19T00:00:00.000Z"
}\`,
        example: 'fetch(\\'/api/skills/react-skill-001\\').then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/skills/:id',
        description: 'อัปเดตข้อมูล Skill',
        payload: \`{
  "name": "React Hooks Master V2",
  "description": "Updated React 19 standards",
  "instructions": "Use new use() hook..."
}\`,
        response: 'JSON Object',
        responseExample: \`{
  "success": true,
  "skill": {
    "id": "react-skill-001",
    "name": "React Hooks Master V2",
    "description": "Updated React 19 standards"
  }
}\`,
        example: 'fetch(\\'/api/skills/react-skill-001\\', { method: \\'PUT\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ description: \\'desc\\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/skills/import',
        description: 'Import Skill ใหม่เข้าระบบจาก URL',
        payload: \`{
  "url": "https://github.com/community/react-skill.git",
  "branch": "main"
}\`,
        response: 'JSON Object',
        responseExample: \`{
  "success": true,
  "importedSkill": {
    "id": "react-skill-002",
    "name": "React Testing"
  }
}\`,
        example: 'fetch(\\'/api/skills/import\\', { method: \\'POST\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ url: \\'url\\' }) }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/skills/:id',
        description: 'ลบ Skill ออกจากระบบ',
        response: 'JSON Object',
        responseExample: \`{
  "success": true,
  "removedId": "react-skill-001"
}\`,
        example: 'fetch(\\'/api/skills/react-skill-001\\', { method: \\'DELETE\\' }).then(res => res.json());'
      }
    ]
  },
  {
    groupName: 'Attachments & Media',
    endpoints: [
      {
        method: 'GET',
        path: '/api/tasks/:taskId/attachments',
        description: 'ดึงไฟล์แนบทั้งหมดของการ์ดงาน แบบเต็ม',
        response: 'JSON Array ของ Attachments',
        responseExample: \`[
  {
    "id": "att-881b2c",
    "taskId": "spec-backend-101",
    "filename": "database-schema.pdf",
    "fileSize": 1048576,
    "mimeType": "application/pdf",
    "uploadedAt": "2026-06-19T00:00:00.000Z",
    "url": "/api/attachments/att-881b2c/download"
  }
]\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101/attachments\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/attachments/:attachmentId',
        description: 'ดึงข้อมูลหรือไฟล์แนบ 1 ไฟล์ด้วย ID',
        response: 'File Stream หรือ JSON Metadata',
        responseExample: \`{
  "id": "att-881b2c",
  "taskId": "spec-backend-101",
  "filename": "database-schema.pdf",
  "fileSize": 1048576,
  "mimeType": "application/pdf",
  "uploadedAt": "2026-06-19T00:00:00.000Z",
  "url": "/api/attachments/att-881b2c/download"
}\`,
        example: 'fetch(\\'/api/attachments/att-881b2c\\').then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/attachments/:attachmentId',
        description: 'ลบไฟล์แนบตาม ID อย่างถาวร',
        response: 'JSON Object',
        responseExample: \`{
  "success": true,
  "deletedAttachmentId": "att-881b2c"
}\`,
        example: 'fetch(\\'/api/attachments/att-881b2c\\', { method: \\'DELETE\\' }).then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id/images',
        description: 'ดึงรูปภาพทั้งหมดที่แนบไว้กับตั๋วงาน',
        response: 'JSON Array ของรูปภาพ',
        responseExample: \`[
  {
    "id": "img-992x3y",
    "taskId": "spec-backend-101",
    "filename": "architecture-diagram.png",
    "fileSize": 512000,
    "mimeType": "image/png",
    "width": 1920,
    "height": 1080,
    "uploadedAt": "2026-06-19T00:00:00.000Z",
    "url": "/api/static/images/img-992x3y.png"
  }
]\`,
        example: 'fetch(\\'/api/tasks/spec-backend-101/images\\').then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/images/upload',
        description: 'อัปโหลดรูปภาพเพื่อนำไปใช้แนบในการ์ดงาน',
        payload: 'FormData (multipart/form-data) บรรจุไฟล์รูปภาพใน field "image"',
        response: 'JSON Object ของรูปที่ถูกอัปโหลดสำเร็จ',
        responseExample: \`{
  "success": true,
  "image": {
    "id": "img-992x3y",
    "filename": "architecture-diagram.png",
    "url": "/api/static/images/img-992x3y.png",
    "fileSize": 512000,
    "mimeType": "image/png"
  }
}\`,
        example: "const formData = new FormData();\\nformData.append('image', fileBlob);\\nfetch('/api/images/upload', { method: 'POST', body: formData }).then(res => res.json());"
      }
    ]
  },
  {
    groupName: 'Git & Local Files',
    endpoints: [
      {
        method: 'GET',
        path: '/api/capabilities',
        description: 'ตรวจสอบความสามารถระบบ (เช่น รองรับ Git หรือ System Commands หรือไม่)',
        response: 'JSON Object แสดง Flags ครบถ้วน',
        responseExample: \`{
  "git": true,
  "fs": true,
  "terminal": true,
  "docker": false,
  "os": "darwin"
}\`,
        example: 'fetch(\\'/api/capabilities\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/local-files',
        description: 'List ไฟล์ในระบบ Local Directory ของโปรเจกต์',
        response: 'JSON Array ของ Object File Info',
        responseExample: \`[
  {
    "name": "src",
    "type": "directory",
    "path": "src",
    "size": 0,
    "modifiedAt": "2026-06-19T00:00:00.000Z"
  },
  {
    "name": "package.json",
    "type": "file",
    "path": "package.json",
    "size": 1543,
    "modifiedAt": "2026-06-19T00:00:00.000Z"
  }
]\`,
        example: 'fetch(\\'/api/local-files?path=.\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/local-files/read',
        description: 'อ่านเนื้อหาไฟล์ใน Local Directory',
        response: 'Text String หรือ JSON',
        responseExample: \`{
  "name": "dev-flow",
  "version": "1.0.0",
  "dependencies": {
    "react": "^18.2.0"
  }
}\`,
        example: 'fetch(\\'/api/local-files/read?path=package.json\\').then(res => res.text());'
      },
      {
        method: 'GET',
        path: '/api/local-files/search',
        description: 'ค้นหาเนื้อหาภายในไฟล์ต่างๆ (Grep Search)',
        response: 'JSON Array ของผลลัพธ์การ Search แบบเต็ม',
        responseExample: \`[
  {
    "file": "src/index.tsx",
    "line": 5,
    "content": "import App from './App';",
    "matchContext": "import React from 'react';\\nimport App from './App';\\nimport './index.css';"
  }
]\`,
        example: 'fetch(\\'/api/local-files/search?q=import+App\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/git/log',
        description: 'ดึง Git Log History ฉบับเต็ม',
        response: 'JSON Array ของ Commits',
        responseExample: \`[
  {
    "hash": "abc1234def5678",
    "author": "DevFlow User <user@example.com>",
    "date": "2026-06-19T00:00:00.000Z",
    "message": "feat(UI): make API groups collapsible in docs modal",
    "refs": "HEAD -> main, origin/main"
  }
]\`,
        example: 'fetch(\\'/api/git/log?maxCount=10\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/git/diff',
        description: 'ดึง Git Diff ที่ยังไม่ได้ commit',
        response: 'Text String ของ Diff Patch',
        responseExample: \`diff --git a/src/index.ts b/src/index.ts
index e69de29..d95f3ad 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import { app } from './app';
+import { config } from './config';
 
 app.listen(3000);\`,
        example: 'fetch(\\'/api/git/diff\\').then(res => res.text());'
      },
      {
        method: 'GET',
        path: '/api/git/show',
        description: 'ดึงข้อมูลรายละเอียด Commit ด้วย hash (git show)',
        response: 'Text String',
        responseExample: \`commit abc1234def5678
Author: DevFlow User <user@example.com>
Date:   Fri Jun 19 09:51:12 2026 +0700

    feat(UI): make API groups collapsible in docs modal

diff --git a/src/components/JsonTemplateModal.tsx b/src/components/JsonTemplateModal.tsx
...
\`,
        example: 'fetch(\\'/api/git/show?hash=abc1234\\').then(res => res.text());'
      },
      {
        method: 'GET',
        path: '/api/git/status',
        description: 'ดึงสถานะ Git ปัจจุบัน (git status)',
        response: 'JSON Object ของสถานะ',
        responseExample: \`{
  "branch": "feature/auth",
  "isClean": false,
  "modifiedFiles": ["src/controllers/authController.ts"],
  "untrackedFiles": ["config/dev.json"],
  "stagedFiles": []
}\`,
        example: 'fetch(\\'/api/git/status\\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/git/branch',
        description: 'ดึงข้อมูลสาขา Git (Branch)',
        response: 'JSON Array ของ Branches ทั้งหมด',
        responseExample: \`[
  { "name": "main", "current": false },
  { "name": "feature/auth", "current": true },
  { "name": "bugfix/login-crash", "current": false }
]\`,
        example: 'fetch(\\'/api/git/branch\\').then(res => res.json());'
      }
    ]
  },
  {
    groupName: 'System Settings',
    endpoints: [
      {
        method: 'GET',
        path: '/api/settings',
        description: 'ดึงการตั้งค่าของแอปพลิเคชันและผู้ใช้ (เช่น AI Model, API Keys) แบบเต็ม',
        response: 'JSON Object แสดง Settings ทั้งหมด',
        responseExample: \`{
  "aiModel": "Antigravity",
  "apiKey": "sk-1234567890abcdef1234567890abcdef",
  "theme": "dark",
  "autoSaveInterval": 300,
  "defaultProjectPath": "/Users/developer/Projects",
  "advancedMode": true,
  "createdAt": "2026-06-19T00:00:00.000Z"
}\`,
        example: 'fetch(\\'/api/settings\\').then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/settings',
        description: 'บันทึกและอัปเดตการตั้งค่าแอปพลิเคชัน',
        payload: \`{
  "aiModel": "Antigravity",
  "apiKey": "sk-NEWKEY123456",
  "theme": "light"
}\`,
        response: 'JSON Object ของ Settings ที่อัปเดตแล้ว',
        responseExample: \`{
  "success": true,
  "settings": {
    "aiModel": "Antigravity",
    "apiKey": "sk-NEWKEY123456",
    "theme": "light",
    "autoSaveInterval": 300,
    "defaultProjectPath": "/Users/developer/Projects",
    "advancedMode": true,
    "updatedAt": "2026-06-19T00:05:00.000Z"
  }
}\`,
        example: 'fetch(\\'/api/settings\\', { method: \\'POST\\', headers: {\\'Content-Type\\': \\'application/json\\'}, body: JSON.stringify({ theme: \\'light\\' }) }).then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/export',
        description: 'ส่งออกข้อมูลทั้งหมดในระบบ (Export Data Backup)',
        response: 'JSON File Stream ของข้อมูล Backup',
        responseExample: \`{
  "version": "1.0",
  "exportedAt": "2026-06-19T00:00:00.000Z",
  "tasks": [...],
  "projects": [...],
  "settings": {...},
  "skills": [...]
}\`,
        example: 'window.open(\\'/api/export\\', \\'_blank\\');'
      },
      {
        method: 'POST',
        path: '/api/import',
        description: 'นำเข้าข้อมูลที่ถูก Backup ไว้เพื่อกู้คืน (Import/Restore)',
        payload: 'Raw JSON Buffer (Backup File)',
        response: 'JSON Object แสดงผลการกู้คืน',
        responseExample: \`{
  "success": true,
  "message": "Restore completed successfully",
  "stats": {
    "tasksRestored": 150,
    "projectsRestored": 3,
    "skillsRestored": 10
  }
}\`,
        example: "const fileInput = document.querySelector('input[type=\"file\"]');\\nconst file = fileInput.files[0];\\nconst reader = new FileReader();\\nreader.onload = (e) => {\\n  fetch('/api/import', { method: 'POST', body: e.target.result }).then(res => res.json());\\n};\\nreader.readAsArrayBuffer(file);"
      }
    ]
  }
];`;

content = content.substring(0, startIdx) + newApiGroupsCode + content.substring(endIdx);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Successfully injected FULL apiGroups definition');
