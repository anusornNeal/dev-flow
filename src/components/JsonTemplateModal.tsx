/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, Copy, Check, Download, FileCode, ChevronRight, ChevronDown } from 'lucide-react';
import { getAgentCatalogHelp, getValidAgentModelEffortExamples, getInvalidAgentModelEffortExamples } from '../lib/agentsConfig';

const SIDEBAR_METHOD_COLORS: Record<string, string> = {
  GET: 'text-emerald-600 dark:text-emerald-400',
  POST: 'text-blue-600 dark:text-blue-400',
  PUT: 'text-amber-600 dark:text-amber-400',
  DELETE: 'text-rose-600 dark:text-rose-400',
};

const PANE_METHOD_COLORS: Record<string, string> = {
  GET: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/50',
  POST: 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800/50',
  PUT: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800/50',
  DELETE: 'bg-rose-50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-800/50',
};

const sampleJson = [
  {
    "id": "spec-backend-101",
    "projectId": "YOUR_PROJECT_UUID_HERE",
    "title": "Setup Authentication API with Bearer Tokens",
    "description": "Create the backend authentication endpoints.\n\nProblem: We lack secure token validation.\nExpected: All protected routes validate JWTs using Argon2 and return 401 if missing.",
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
      },
      {
        "id": "auth-2",
        "text": "Implement JWT validation middleware with a 15m expiration boundary",
        "completed": false
      },
      {
        "id": "auth-3",
        "text": "Add Jest token validation tests against empty Authorization keys",
        "completed": false
      }
    ],
    "agent": "Codex",
    "model": "GPT-5.4",
    "effort": "medium",
    "reasoning": "Standard backend security implementation. Cleanly separated from frontend to allow parallel work.",
    "acceptanceCriteria": "- All protected API endpoints return 401 when missing a valid JWT.\n- Valid tokens grant access.",
    "verification": "Run `npm run test:auth` and ensure 100% coverage on new middleware.",
    "repoContext": "Relies on the `argon2` module implemented last week.",
    "jiraKey": "QCA-3314",
    "repo": "https://github.com/my-org/auth-service"
  },
  {
    "id": "spec-frontend-102",
    "projectId": "YOUR_PROJECT_UUID_HERE",
    "title": "Store Authentication JWT in Frontend Session",
    "description": "Implement frontend storage and injection of JWT tokens for API requests.",
    "status": "backlog",
    "priority": "high",
    "category": "frontend",
    "tags": ["auth", "session"],
    "branch": "feature/api-auth-frontend",
    "targetFiles": [
      "src/api/apiClient.ts",
      "src/components/LoginForm.tsx"
    ],
    "checklist": [
      {
        "id": "fe-auth-1",
        "text": "Store received JWT in secure cookie after successful login",
        "completed": false
      },
      {
        "id": "fe-auth-2",
        "text": "Update apiClient.ts to inject the Authorization header into all requests",
        "completed": false
      }
    ],
    "agent": "Codex",
    "model": "GPT-5.4 Mini",
    "effort": "low",
    "reasoning": "Separated from backend API work. GPT-5.4 Mini is sufficient for basic frontend API client updates.",
    "acceptanceCriteria": "- Login saves the cookie.\n- API requests include the token.",
    "verification": "Start frontend dev server, login, and inspect network request headers.",
    "repoContext": "Frontend uses native fetch API wrapped in apiClient.ts.",
    "jiraKey": "QCA-3314",
    "repo": "https://github.com/my-org/frontend-app"
  }
];

const jsonString = JSON.stringify(sampleJson, null, 2);

const apiGroups = [
  {
    groupName: 'Tasks & Batch Operations',
    endpoints: [
      {
        method: 'GET',
        path: '/api/tasks',
        description: 'เรียกดูรายการการ์ดงาน (Tickets) ทั้งหมดในระบบ sandbox',
        response: 'JSON Array ของ Tasks ทั้งหมดแบบเต็มรูปแบบ',
        responseExample: `[
  {
    "id": "spec-backend-101",
    "projectId": "proj-xyz789",
    "title": "Setup Authentication API with Bearer Tokens",
    "description": "Create the backend authentication endpoints.\n\nProblem: We lack secure token validation.",
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
    "verification": "Run \`npm run test:auth\`",
    "repoContext": "Relies on the argon2 module",
    "jiraKey": "QCA-3314",
    "repo": "https://github.com/my-org/auth-service",
    "createdAt": "2026-06-19T00:00:00.000Z",
    "updatedAt": "2026-06-19T00:00:00.000Z"
  }
]`,
        example: 'fetch(\'/api/tasks\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/schema/task',
        description: 'ดึงโครงสร้าง JSON Schema ของข้อมูลการ์ดงาน (Task)',
        response: 'JSON Schema Definition Object',
        responseExample: `{
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
}`,
        example: 'fetch(\'/api/schema/task\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id',
        description: 'เรียกดูการ์ดงานชิ้นใดชิ้นหนึ่งด้วย ID พร้อมฟิลด์ทั้งหมด',
        response: 'JSON Object ของ Task แบบเต็มรูปแบบ',
        responseExample: `{
  "id": "spec-backend-101",
  "projectId": "proj-xyz789",
  "title": "Setup Authentication API with Bearer Tokens",
  "description": "Create the backend authentication endpoints.\n\nProblem: We lack secure token validation.",
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
  "verification": "Run \`npm run test:auth\`",
  "repoContext": "Relies on the argon2 module",
  "jiraKey": "QCA-3314",
  "repo": "https://github.com/my-org/auth-service",
  "createdAt": "2026-06-19T00:00:00.000Z",
  "updatedAt": "2026-06-19T00:00:00.000Z"
}`,
        example: 'fetch(\'/api/tasks/spec-backend-101\').then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks',
        description: 'สร้างตั๋วงานเดี่ยว หรือนำเข้าการ์ดแบบกลุ่ม (Bulk Import)',
        payload: `{
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
}`,
        response: 'JSON Object แสดงสถิติจำนวน { success, createdCount, updatedCount, tasks }',
        responseExample: `{
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
}`,
        example: 'fetch(\'/api/tasks\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ projectId: \'proj-xyz789\', tasks: [{title: \'New Task\'}] }) }).then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/tasks',
        description: 'เขียนและอัปเดตบันทึกการ์ดงานพร้อมกันแบบกลุ่ม (Batch Upsert)',
        payload: `{
  "projectId": "proj-xyz789",
  "tasks": [
    {
      "id": "spec-backend-101",
      "title": "Updated Task Title",
      "status": "in-progress"
    }
  ]
}`,
        response: 'JSON Object ยืนยันสถานะการอัปเดตแบบกลุ่ม',
        responseExample: `{
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
      "verification": "Run \`npm run test:auth\`",
      "repoContext": "Relies on the argon2 module",
      "jiraKey": "QCA-3314",
      "repo": "https://github.com/my-org/auth-service",
      "createdAt": "2026-06-19T00:00:00.000Z",
      "updatedAt": "2026-06-19T00:05:00.000Z"
    }
  ]
}`,
        example: 'fetch(\'/api/tasks\', { method: \'PUT\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ projectId: \'proj-xyz789\', tasks: [{id: \'spec-backend-101\', title: \'Updated\'}] }) }).then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/tasks/:id',
        description: 'อัปเดตข้อมูลย่อยของการ์ดงาน เช่น เปลี่ยนสถานะเลน, แก้ไข checklist',
        payload: `{
  "status": "in-progress",
  "priority": "critical",
  "checklist": [
    {
      "id": "auth-1",
      "text": "Add Argon2 logic",
      "completed": true
    }
  ]
}`,
        response: 'JSON Object ของ Task ที่ผ่านการอัปเดตเรียบร้อย แบบเต็มรูปแบบ',
        responseExample: `{
  "id": "spec-backend-101",
  "projectId": "proj-xyz789",
  "title": "Setup Authentication API with Bearer Tokens",
  "description": "Create the backend authentication endpoints.\n\nProblem: We lack secure token validation.",
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
  "verification": "Run \`npm run test:auth\`",
  "repoContext": "Relies on the argon2 module",
  "jiraKey": "QCA-3314",
  "repo": "https://github.com/my-org/auth-service",
  "createdAt": "2026-06-19T00:00:00.000Z",
  "updatedAt": "2026-06-19T00:05:00.000Z"
}`,
        example: 'fetch(\'/api/tasks/spec-backend-101\', { method: \'PUT\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ status: \'in-progress\' }) }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/tasks/:id',
        description: 'ลบการ์ดงานชิ้นนั้นๆ อ้างอิงจาก ID อย่างถาวร',
        response: 'JSON Object ยืนยันการลบ พร้อมข้อมูล Task ที่ถูกลบ',
        responseExample: `{
  "success": true,
  "removed": {
    "id": "spec-backend-101",
    "projectId": "proj-xyz789",
    "title": "Setup Authentication API with Bearer Tokens",
    "status": "todo"
  }
}`,
        example: 'fetch(\'/api/tasks/spec-backend-101\', { method: \'DELETE\' }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/batch',
        description: 'อัปเดตและสร้างบันทึกการ์ดงานพร้อมกันแบบกลุ่ม',
        payload: `{
  "projectId": "proj-xyz789",
  "tasks": [
    { "id": "task-1", "status": "in-progress" },
    { "id": "task-2", "status": "done" }
  ]
}`,
        response: 'JSON Object แสดงจำนวนที่อัปเดต',
        responseExample: `{
  "success": true,
  "updatedCount": 2,
  "tasks": [
    { "id": "task-1", "status": "in-progress", "title": "Task 1", "projectId": "proj-xyz789" },
    { "id": "task-2", "status": "done", "title": "Task 2", "projectId": "proj-xyz789" }
  ]
}`,
        example: 'fetch(\'/api/tasks/batch\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ projectId: \'proj-xyz789\', tasks: [{id: \'task-1\', status: \'in-progress\'}] }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/batch/move',
        description: 'ย้ายสถานะเลนการทำงานของการ์ดแบบกลุ่ม',
        payload: `{
  "taskIds": ["spec-backend-101", "spec-frontend-102"],
  "status": "done"
}`,
        response: 'JSON Object ยืนยันการทำงาน',
        responseExample: `{
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
}`,
        example: 'fetch(\'/api/tasks/batch/move\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ taskIds: [\'spec-backend-101\'], status: \'done\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/batch/checklist/toggle',
        description: 'สลับสถานะความสำเร็จของข้อกำหนด Checklist แบบกลุ่ม',
        payload: `{
  "taskIds": ["spec-backend-101", "spec-frontend-102"],
  "checklistId": "auth-1"
}`,
        response: 'JSON Object ยืนยันการทำงาน',
        responseExample: `{
  "success": true,
  "updatedCount": 2
}`,
        example: 'fetch(\'/api/tasks/batch/checklist/toggle\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ taskIds: [\'spec-backend-101\'], checklistId: \'auth-1\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/batch/assign',
        description: 'มอบหมาย Agent แบบกลุ่ม',
        payload: `{
  "taskIds": ["spec-backend-101", "spec-frontend-102"],
  "agent": "Antigravity"
}`,
        response: 'JSON Object ยืนยันการทำงาน',
        responseExample: `{
  "success": true,
  "updatedCount": 2
}`,
        example: 'fetch(\'/api/tasks/batch/assign\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ taskIds: [\'spec-backend-101\'], agent: \'Antigravity\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/move',
        description: 'ย้ายสถานะเลนการทำงานของการ์ดชิ้นหนึ่งๆ',
        payload: `{
  "status": "done"
}`,
        response: 'JSON Object สถานะตอบกลับ แบบเต็มรูปแบบ',
        responseExample: `{
  "success": true,
  "task": {
    "id": "spec-backend-101",
    "projectId": "proj-xyz789",
    "title": "Setup Authentication API with Bearer Tokens",
    "description": "Create the backend authentication endpoints.\n\nProblem: We lack secure token validation.",
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
    "verification": "Run \`npm run test:auth\`",
    "repoContext": "Relies on the argon2 module",
    "jiraKey": "QCA-3314",
    "repo": "https://github.com/my-org/auth-service",
    "createdAt": "2026-06-19T00:00:00.000Z",
    "updatedAt": "2026-06-19T00:10:00.000Z"
  }
}`,
        example: 'fetch(\'/api/tasks/spec-backend-101/move\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ status: \'done\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/checklist/toggle',
        description: 'สลับสถานะความสำเร็จของข้อกำหนด Checklist item ภายใน Task เดียว',
        payload: `{
  "checklistId": "auth-1"
}`,
        response: 'JSON Object ยืนยันการทำงาน',
        responseExample: `{
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
}`,
        example: 'fetch(\'/api/tasks/spec-backend-101/checklist/toggle\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ checklistId: \'auth-1\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/assign',
        description: 'มอบหมาย Agent สำหรับ Task เดียว',
        payload: `{
  "agent": "Antigravity"
}`,
        response: 'JSON Object ยืนยันการทำงาน',
        responseExample: `{
  "success": true,
  "task": {
    "id": "spec-backend-101",
    "title": "Setup Authentication API",
    "agent": "Antigravity"
  }
}`,
        example: 'fetch(\'/api/tasks/spec-backend-101/assign\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ agent: \'Codex\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/import-file',
        description: 'นำเข้าตั๋วงานจากไฟล์ .json หรือ .md',
        payload: 'FormData (multipart/form-data) บรรจุไฟล์ (key: "file")',
        response: 'JSON Object แสดงจำนวนที่ถูก import พร้อมข้อมูล Tasks อย่างละเอียด',
        responseExample: `{
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
}`,
        example: 'const formData = new FormData();\nformData.append("file", fileBlob);\nfetch(\'/api/tasks/import-file\', { method: \'POST\', body: formData }).then(res => res.json());'
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
        responseExample: `{
  "prompt": "You are Antigravity, a powerful agentic AI coding assistant...\n\nThe user wants you to implement the following task:\n\nTask: Setup Authentication API with Bearer Tokens\nDescription: Create the backend authentication endpoints...\n\nChecklist:\n[ ] Add Argon2 logic\n"
}`,
        example: 'fetch(\'/api/tasks/spec-backend-101/prompt\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id/agent-context',
        description: 'ดึงข้อมูล Context ล่าสุดเพื่อเตรียมรัน Agent แบบครอบคลุม',
        response: 'JSON Object ของ Context',
        responseExample: `{
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
}`,
        example: 'fetch(\'/api/tasks/spec-backend-101/agent-context\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id/agent-runs',
        description: 'ดึงประวัติการรัน Agent ทั้งหมดของ Task',
        response: 'JSON Array แสดงประวัติการรันอย่างละเอียด',
        responseExample: `[
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
]`,
        example: 'fetch(\'/api/tasks/spec-backend-101/agent-runs\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id/agent-runs/:runId/history',
        description: 'ดึงประวัติการสนทนาและ Message History ของการรัน Agent',
        response: 'JSON Array ของ Messages',
        responseExample: `[
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
]`,
        example: 'fetch(\'/api/tasks/spec-backend-101/agent-runs/run-1/history\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id/agent-runs/:runId/log',
        description: 'ดึงข้อมูลบันทึกการทำงาน (Log) ของ Agent ที่รันผ่าน Task นี้แบบดิบ (Raw Text)',
        response: 'Text String แสดง Log การทำงานแบบหลายบรรทัด',
        responseExample: `[2026-06-19T00:00:00.000Z] [INFO] Agent started processing task DVF-0001
[2026-06-19T00:00:02.000Z] [INFO] Loaded context and repository schema
[2026-06-19T00:00:10.000Z] [TOOL] Executing write_to_file...
[2026-06-19T00:05:00.000Z] [SUCCESS] Agent marked task as complete`,
        example: 'fetch(\'/api/tasks/spec-backend-101/agent-runs/run-123/log\').then(res => res.text());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/agent-runs/retry',
        description: 'สั่ง Retry การรัน Agent ที่ล้มเหลว หรือถูกยกเลิก',
        response: 'JSON Object สถานะของการเริ่มใหม่',
        responseExample: `{
  "success": true,
  "newRunId": "run-e5f6g7h8",
  "status": "running"
}`,
        example: 'fetch(\'/api/tasks/spec-backend-101/agent-runs/retry\', { method: \'POST\' }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/agent-runs/cancel',
        description: 'สั่ง Cancel การรัน Agent ปัจจุบัน',
        response: 'JSON Object สถานะการยกเลิก',
        responseExample: `{
  "success": true,
  "cancelledRunId": "run-e5f6g7h8",
  "status": "cancelled"
}`,
        example: 'fetch(\'/api/tasks/spec-backend-101/agent-runs/cancel\', { method: \'POST\' }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/agent-complete',
        description: 'แจ้งสถานะ Complete จากตัว Agent โดยตรงเพื่ออัปเดต Task',
        payload: `{
  "status": "success",
  "summary": "Finished UI and fixed all tests",
  "completedChecklistIds": ["auth-1"]
}`,
        response: 'JSON Object ยืนยัน',
        responseExample: `{
  "success": true,
  "updatedTask": {
    "id": "spec-backend-101",
    "status": "done"
  }
}`,
        example: 'fetch(\'/api/tasks/spec-backend-101/agent-complete\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ status: \'success\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/agent-runs/:runId/complete',
        description: 'แจ้งสถานะ Complete ระบุตาม Run ID (เฉพาะเจาะจงเจาะลึก)',
        payload: `{
  "status": "success",
  "artifacts": ["docs/agent-tasks/result.md"]
}`,
        response: 'JSON Object ยืนยัน',
        responseExample: `{
  "success": true,
  "runId": "run-f1a2b3c4"
}`,
        example: 'fetch(\'/api/tasks/spec-backend-101/agent-runs/run-1/complete\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ status: \'success\' }) }).then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/prompt-template/sections',
        description: 'ดึงหัวข้อ Prompt Template ทั้งหมด',
        response: 'JSON Array แบบเต็ม',
        responseExample: `[
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
]`,
        example: 'fetch(\'/api/prompt-template/sections\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/prompt-template/section',
        description: 'ดึงเนื้อหา Prompt Template ล่าสุดตาม Section ID',
        response: 'JSON Object รายละเอียดของ 1 Section',
        responseExample: `{
  "id": "sys-prompt",
  "name": "System Identity",
  "content": "You are Antigravity...",
  "isRequired": true,
  "order": 0
}`,
        example: 'fetch(\'/api/prompt-template/section?id=sys-prompt\').then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/prompt-template/section',
        description: 'อัปเดตเนื้อหา Prompt Template',
        payload: `{
  "id": "sys-prompt",
  "content": "You are Antigravity, an elite agent..."
}`,
        response: 'JSON Object ยืนยันอัปเดต',
        responseExample: `{
  "success": true,
  "updatedSection": {
    "id": "sys-prompt",
    "content": "You are Antigravity, an elite agent..."
  }
}`,
        example: 'fetch(\'/api/prompt-template/section\', { method: \'PUT\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ id: \'sys-prompt\', content: \'hi\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/prompt-template/preview',
        description: 'ดูตัวอย่างผลลัพธ์ของ Prompt (Preview) พร้อมแทนที่ตัวแปร (Variables)',
        payload: `{
  "template": "Task: {{title}}",
  "variables": { "title": "Setup API" }
}`,
        response: 'JSON Object แสดงพรีวิว',
        responseExample: `{
  "preview": "Task: Setup API"
}`,
        example: 'fetch(\'/api/prompt-template/preview\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ template: \'Task: {{title}}\', variables: {title: \'Test\'} }) }).then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/prompt-overrides/sections',
        description: 'ดึงข้อมูล Overrides ของ Prompt ที่ถูกกำหนดทับค่าปกติ',
        response: 'JSON Array ของ Overrides',
        responseExample: `[
  {
    "projectId": "proj-xyz789",
    "sectionId": "sys-prompt",
    "overrideContent": "You are a backend specific agent."
  }
]`,
        example: 'fetch(\'/api/prompt-overrides/sections\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/prompt-overrides/section',
        description: 'ดึง override ของ section หนึ่ง',
        response: 'JSON Object',
        responseExample: `{
  "projectId": "proj-xyz789",
  "sectionId": "sys-prompt",
  "overrideContent": "You are a backend specific agent."
}`,
        example: 'fetch(\'/api/prompt-overrides/section?id=sys-prompt\').then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/prompt-overrides/section',
        description: 'อัปเดต override ของ section หนึ่ง',
        payload: `{
  "id": "sys-prompt",
  "projectId": "proj-xyz789",
  "overrideContent": "New specialized agent prompt"
}`,
        response: 'JSON Object',
        responseExample: `{
  "success": true,
  "override": {
    "sectionId": "sys-prompt",
    "overrideContent": "New specialized agent prompt"
  }
}`,
        example: 'fetch(\'/api/prompt-overrides/section\', { method: \'PUT\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ id: \'sys-prompt\', overrideContent: \'...\' }) }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/prompt-overrides/section',
        description: 'ลบ override เพื่อกลับไปใช้ค่า Default',
        response: 'JSON Object',
        responseExample: `{
  "success": true,
  "deletedSectionId": "sys-prompt"
}`,
        example: 'fetch(\'/api/prompt-overrides/section?id=sys-prompt\', { method: \'DELETE\' }).then(res => res.json());'
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
        responseExample: `[
  {
    "id": "proj-xyz789",
    "name": "DevFlow Sandbox",
    "repoUrl": "https://github.com/my/dev-flow-sandbox",
    "description": "Sandbox project for testing DevFlow API",
    "localPath": "/Users/developer/Projects/dev-flow-sandbox",
    "taskIdPrefix": "DVF",
    "createdAt": "2024-03-10T12:00:00.000Z"
  }
]`,
        example: 'fetch(\'/api/projects\').then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/projects',
        description: 'สร้างโปรเจกต์ใหม่เพื่อใช้ผูกกับการ์ดงาน',
        payload: `{
  "name": "Authentication Microservice",
  "repoUrl": "https://github.com/my/auth-service",
  "description": "Handles user login and JWT generation",
  "localPath": "/Users/dev/auth-service",
  "taskIdPrefix": "AUTH"
}`,
        response: 'JSON Object ของ Project ที่สร้างเสร็จ แบบเต็ม',
        responseExample: `{
  "id": "proj-abc123",
  "name": "Authentication Microservice",
  "repoUrl": "https://github.com/my/auth-service",
  "description": "Handles user login and JWT generation",
  "localPath": "/Users/dev/auth-service",
  "taskIdPrefix": "AUTH",
  "createdAt": "2026-06-19T00:00:00.000Z"
}`,
        example: 'fetch(\'/api/projects\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ name: \'Test\', repoUrl: \'http://\' }) }).then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/projects/:id',
        description: 'อัปเดตข้อมูลโปรเจกต์ เช่น เปลี่ยนชื่อ หรือ URL แบบเต็ม',
        payload: `{
  "name": "Auth Service V2",
  "taskIdPrefix": "AUTHV2"
}`,
        response: 'JSON Object ของ Project ที่อัปเดตเสร็จ',
        responseExample: `{
  "id": "proj-abc123",
  "name": "Auth Service V2",
  "repoUrl": "https://github.com/my/auth-service",
  "description": "Handles user login and JWT generation",
  "localPath": "/Users/dev/auth-service",
  "taskIdPrefix": "AUTHV2",
  "createdAt": "2026-06-19T00:00:00.000Z",
  "updatedAt": "2026-06-19T00:10:00.000Z"
}`,
        example: 'fetch(\'/api/projects/proj-abc123\', { method: \'PUT\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ name: \'Auth V2\' }) }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/projects',
        description: 'ลบข้อมูล Project แบบกลุ่ม',
        response: 'JSON Object',
        responseExample: `{
  "success": true,
  "deletedCount": 3
}`,
        example: 'fetch(\'/api/projects\', { method: \'DELETE\' }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/projects/:id',
        description: 'ลบโปรเจกต์พร้อมตั๋วงานที่ผูกกับโปรเจกต์นั้นอย่างถาวร',
        response: '{ "success": true, "removedId": "project-id" }',
        responseExample: `{
  "success": true,
  "removedId": "proj-xyz789",
  "deletedTasksCount": 15
}`,
        example: 'fetch(\'/api/projects/proj-abc123\', { method: \'DELETE\' }).then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/projects/:id/prompt-sections',
        description: 'ดึง Prompt Sections ที่ตั้งค่า override สำหรับ Project หนึ่ง',
        response: 'JSON Array ของ overrides',
        responseExample: `[
  {
    "sectionId": "sys-prompt",
    "overrideContent": "Project specific instructions here."
  }
]`,
        example: 'fetch(\'/api/projects/proj-abc123/prompt-sections\').then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/projects/:id/prompt-overrides/:sectionId',
        description: 'อัปเดต Prompt Override ของ Project เฉพาะ',
        payload: `{ "content": "You must use TypeScript strictly." }`,
        response: 'JSON Object',
        responseExample: `{
  "success": true,
  "override": {
    "sectionId": "sys-prompt",
    "content": "You must use TypeScript strictly."
  }
}`,
        example: 'fetch(\'/api/projects/proj-abc123/prompt-overrides/sys-prompt\', { method: \'PUT\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ content: \'hi\' }) }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/projects/:id/prompt-overrides/:sectionId',
        description: 'ลบ Prompt Override ของ Project เฉพาะ',
        response: 'JSON Object',
        responseExample: `{
  "success": true,
  "deletedSectionId": "sys-prompt"
}`,
        example: 'fetch(\'/api/projects/proj-abc123/prompt-overrides/sys-prompt\', { method: \'DELETE\' }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/projects/:id/prompt-preview',
        description: 'Preview Prompt ภายในบริบทของ Project (แทนที่ตัวแปร)',
        payload: `{ "variables": { "projectName": "Auth V2" } }`,
        response: 'JSON Object',
        responseExample: `{
  "preview": "Welcome to Auth V2 project prompt preview..."
}`,
        example: 'fetch(\'/api/projects/proj-abc123/prompt-preview\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ variables: {} }) }).then(res => res.json());'
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
        responseExample: `[
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
]`,
        example: 'fetch(\'/api/skills\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/skills/authoring',
        description: 'ดึงรายการ Authoring Skills (ผู้แต่ง)',
        response: 'JSON Array',
        responseExample: `[
  {
    "id": "my-custom-skill-1",
    "name": "Company Custom Auth",
    "isAuthor": true,
    "localPath": "/Users/dev/.skills/custom-auth"
  }
]`,
        example: 'fetch(\'/api/skills/authoring\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/skills/:id',
        description: 'ดึงรายละเอียด Skill ด้วย ID',
        response: 'JSON Object ของ 1 Skill',
        responseExample: `{
  "id": "react-skill-001",
  "name": "React Hooks Master",
  "description": "Skill for writing optimized React Hooks and functional components",
  "author": "DevFlow Community",
  "version": "1.0.2",
  "repository": "https://github.com/skills/react-hooks",
  "instructions": "When writing React, always use useMemo for heavy calculations...",
  "createdAt": "2026-06-19T00:00:00.000Z"
}`,
        example: 'fetch(\'/api/skills/react-skill-001\').then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/skills/:id',
        description: 'อัปเดตข้อมูล Skill',
        payload: `{
  "name": "React Hooks Master V2",
  "description": "Updated React 19 standards",
  "instructions": "Use new use() hook..."
}`,
        response: 'JSON Object',
        responseExample: `{
  "success": true,
  "skill": {
    "id": "react-skill-001",
    "name": "React Hooks Master V2",
    "description": "Updated React 19 standards"
  }
}`,
        example: 'fetch(\'/api/skills/react-skill-001\', { method: \'PUT\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ description: \'desc\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/skills/import',
        description: 'Import Skill ใหม่เข้าระบบจาก URL',
        payload: `{
  "url": "https://github.com/community/react-skill.git",
  "branch": "main"
}`,
        response: 'JSON Object',
        responseExample: `{
  "success": true,
  "importedSkill": {
    "id": "react-skill-002",
    "name": "React Testing"
  }
}`,
        example: 'fetch(\'/api/skills/import\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ url: \'url\' }) }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/skills/:id',
        description: 'ลบ Skill ออกจากระบบ',
        response: 'JSON Object',
        responseExample: `{
  "success": true,
  "removedId": "react-skill-001"
}`,
        example: 'fetch(\'/api/skills/react-skill-001\', { method: \'DELETE\' }).then(res => res.json());'
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
        responseExample: `[
  {
    "id": "att-881b2c",
    "taskId": "spec-backend-101",
    "filename": "database-schema.pdf",
    "fileSize": 1048576,
    "mimeType": "application/pdf",
    "uploadedAt": "2026-06-19T00:00:00.000Z",
    "url": "/api/attachments/att-881b2c/download"
  }
]`,
        example: 'fetch(\'/api/tasks/spec-backend-101/attachments\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/attachments/:attachmentId',
        description: 'ดึงข้อมูลหรือไฟล์แนบ 1 ไฟล์ด้วย ID',
        response: 'File Stream หรือ JSON Metadata',
        responseExample: `{
  "id": "att-881b2c",
  "taskId": "spec-backend-101",
  "filename": "database-schema.pdf",
  "fileSize": 1048576,
  "mimeType": "application/pdf",
  "uploadedAt": "2026-06-19T00:00:00.000Z",
  "url": "/api/attachments/att-881b2c/download"
}`,
        example: 'fetch(\'/api/attachments/att-881b2c\').then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/attachments/:attachmentId',
        description: 'ลบไฟล์แนบตาม ID อย่างถาวร',
        response: 'JSON Object',
        responseExample: `{
  "success": true,
  "deletedAttachmentId": "att-881b2c"
}`,
        example: 'fetch(\'/api/attachments/att-881b2c\', { method: \'DELETE\' }).then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id/images',
        description: 'ดึงรูปภาพทั้งหมดที่แนบไว้กับตั๋วงาน',
        response: 'JSON Array ของรูปภาพ',
        responseExample: `[
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
]`,
        example: 'fetch(\'/api/tasks/spec-backend-101/images\').then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/images/upload',
        description: 'อัปโหลดรูปภาพเพื่อนำไปใช้แนบในการ์ดงาน',
        payload: 'FormData (multipart/form-data) บรรจุไฟล์รูปภาพใน field "image"',
        response: 'JSON Object ของรูปที่ถูกอัปโหลดสำเร็จ',
        responseExample: `{
  "success": true,
  "image": {
    "id": "img-992x3y",
    "filename": "architecture-diagram.png",
    "url": "/api/static/images/img-992x3y.png",
    "fileSize": 512000,
    "mimeType": "image/png"
  }
}`,
        example: "const formData = new FormData();\nformData.append('image', fileBlob);\nfetch('/api/images/upload', { method: 'POST', body: formData }).then(res => res.json());"
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
        responseExample: `{
  "git": true,
  "fs": true,
  "terminal": true,
  "docker": false,
  "os": "darwin"
}`,
        example: 'fetch(\'/api/capabilities\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/local-files',
        description: 'List ไฟล์ในระบบ Local Directory ของโปรเจกต์',
        response: 'JSON Array ของ Object File Info',
        responseExample: `[
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
]`,
        example: 'fetch(\'/api/local-files?path=.\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/local-files/read',
        description: 'อ่านเนื้อหาไฟล์ใน Local Directory',
        response: 'Text String หรือ JSON',
        responseExample: `{
  "name": "dev-flow",
  "version": "1.0.0",
  "dependencies": {
    "react": "^18.2.0"
  }
}`,
        example: 'fetch(\'/api/local-files/read?path=package.json\').then(res => res.text());'
      },
      {
        method: 'GET',
        path: '/api/local-files/search',
        description: 'ค้นหาเนื้อหาภายในไฟล์ต่างๆ (Grep Search)',
        response: 'JSON Array ของผลลัพธ์การ Search แบบเต็ม',
        responseExample: `[
  {
    "file": "src/index.tsx",
    "line": 5,
    "content": "import App from './App';",
    "matchContext": "import React from 'react';\nimport App from './App';\nimport './index.css';"
  }
]`,
        example: 'fetch(\'/api/local-files/search?q=import+App\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/git/log',
        description: 'ดึง Git Log History ฉบับเต็ม',
        response: 'JSON Array ของ Commits',
        responseExample: `[
  {
    "hash": "abc1234def5678",
    "author": "DevFlow User <user@example.com>",
    "date": "2026-06-19T00:00:00.000Z",
    "message": "feat(UI): make API groups collapsible in docs modal",
    "refs": "HEAD -> main, origin/main"
  }
]`,
        example: 'fetch(\'/api/git/log?maxCount=10\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/git/diff',
        description: 'ดึง Git Diff ที่ยังไม่ได้ commit',
        response: 'Text String ของ Diff Patch',
        responseExample: `diff --git a/src/index.ts b/src/index.ts
index e69de29..d95f3ad 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import { app } from './app';
+import { config } from './config';
 
 app.listen(3000);`,
        example: 'fetch(\'/api/git/diff\').then(res => res.text());'
      },
      {
        method: 'GET',
        path: '/api/git/show',
        description: 'ดึงข้อมูลรายละเอียด Commit ด้วย hash (git show)',
        response: 'Text String',
        responseExample: `commit abc1234def5678
Author: DevFlow User <user@example.com>
Date:   Fri Jun 19 09:51:12 2026 +0700

    feat(UI): make API groups collapsible in docs modal

diff --git a/src/components/JsonTemplateModal.tsx b/src/components/JsonTemplateModal.tsx
...
`,
        example: 'fetch(\'/api/git/show?hash=abc1234\').then(res => res.text());'
      },
      {
        method: 'GET',
        path: '/api/git/status',
        description: 'ดึงสถานะ Git ปัจจุบัน (git status)',
        response: 'JSON Object ของสถานะ',
        responseExample: `{
  "branch": "feature/auth",
  "isClean": false,
  "modifiedFiles": ["src/controllers/authController.ts"],
  "untrackedFiles": ["config/dev.json"],
  "stagedFiles": []
}`,
        example: 'fetch(\'/api/git/status\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/git/branch',
        description: 'ดึงข้อมูลสาขา Git (Branch)',
        response: 'JSON Array ของ Branches ทั้งหมด',
        responseExample: `[
  { "name": "main", "current": false },
  { "name": "feature/auth", "current": true },
  { "name": "bugfix/login-crash", "current": false }
]`,
        example: 'fetch(\'/api/git/branch\').then(res => res.json());'
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
        responseExample: `{
  "aiModel": "Antigravity",
  "apiKey": "sk-1234567890abcdef1234567890abcdef",
  "theme": "dark",
  "autoSaveInterval": 300,
  "defaultProjectPath": "/Users/developer/Projects",
  "advancedMode": true,
  "createdAt": "2026-06-19T00:00:00.000Z"
}`,
        example: 'fetch(\'/api/settings\').then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/settings',
        description: 'บันทึกและอัปเดตการตั้งค่าแอปพลิเคชัน',
        payload: `{
  "aiModel": "Antigravity",
  "apiKey": "sk-NEWKEY123456",
  "theme": "light"
}`,
        response: 'JSON Object ของ Settings ที่อัปเดตแล้ว',
        responseExample: `{
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
}`,
        example: 'fetch(\'/api/settings\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ theme: \'light\' }) }).then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/export',
        description: 'ส่งออกข้อมูลทั้งหมดในระบบ (Export Data Backup)',
        response: 'JSON File Stream ของข้อมูล Backup',
        responseExample: `{
  "version": "1.0",
  "exportedAt": "2026-06-19T00:00:00.000Z",
  "tasks": [...],
  "projects": [...],
  "settings": {...},
  "skills": [...]
}`,
        example: 'window.open(\'/api/export\', \'_blank\');'
      },
      {
        method: 'POST',
        path: '/api/import',
        description: 'นำเข้าข้อมูลที่ถูก Backup ไว้เพื่อกู้คืน (Import/Restore)',
        payload: 'Raw JSON Buffer (Backup File)',
        response: 'JSON Object แสดงผลการกู้คืน',
        responseExample: `{
  "success": true,
  "message": "Restore completed successfully",
  "stats": {
    "tasksRestored": 150,
    "projectsRestored": 3,
    "skillsRestored": 10
  }
}`,
        example: `const fileInput = document.querySelector('input[type="file"]');\nconst file = fileInput.files[0];\nconst reader = new FileReader();\nreader.onload = (e) => {\n  fetch('/api/import', { method: 'POST', body: e.target.result }).then(res => res.json());\n};\nreader.readAsArrayBuffer(file);`
      }
    ]
  }
];const apiSpecsWithIds = apiGroups.flatMap((group, groupIndex) => 
  group.endpoints.map((spec, specIndex) => ({
    ...spec,
    groupName: group.groupName,
    id: `api-${groupIndex}-${specIndex}`
  }))
);

interface JsonTemplateModalProps {
  onClose: () => void;
}

export default function JsonTemplateModal({ onClose }: JsonTemplateModalProps) {
  const [selectedItemId, setSelectedItemId] = useState<string>('schema');
  const [copied, setCopied] = useState(false);
  const [copiedText, setCopiedText] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const toggleGroup = (groupName: string) => {
    setExpandedGroups(prev => ({
      ...prev,
      [groupName]: !prev[groupName]
    }));
  };

  const handleCopy = (text: string, type: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(type);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
      setCopiedText('');
    }, 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'backlog-schema-template.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in select-text">
      {/* Click outside to close */}
      <div className="fixed inset-0" onClick={onClose} />

      <div className="bg-[#fcfaf5] dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] w-full max-w-5xl rounded-3xl shadow-2xl relative z-10 overflow-hidden flex font-sans h-[85vh]">

        
        {/* Left Sidebar Pane */}
        <div className="w-64 bg-[#f5eedf]/60 dark:bg-[#1e1914]/60 backdrop-blur-md border-r border-[#ebdcb9] dark:border-[#584a3b] flex flex-col z-20 shadow-[4px_0_24px_rgba(0,0,0,0.02)] shrink-0">
          <div className="p-5 border-b border-[#ebdcb9]/60 dark:border-[#584a3b]/60 flex items-center gap-2">
            <FileCode size={18} className="text-[#bf8a50] dark:text-[#d6b56d]" />
            <h2 className="text-xs font-black text-[#5c493c] dark:text-[#f3eadf] tracking-tight uppercase">
              Documentation
            </h2>
          </div>
          
          <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-1">
            <button
              type="button"
              onClick={() => setSelectedItemId('schema')}
              className={`w-full text-left px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 ${
                selectedItemId === 'schema'
                  ? 'bg-white dark:bg-[#292119] text-[#784d21] dark:text-[#f3eadf] shadow-sm ring-1 ring-[#ebdcb9] dark:ring-[#584a3b]'
                  : 'text-[#9e8470] dark:text-[#b8ab9f] hover:bg-white/50 dark:hover:bg-[#292119]/50 hover:text-[#5c493c] dark:hover:text-[#f3eadf]'
              }`}
            >
              <FileCode size={14} className={selectedItemId === 'schema' ? 'text-[#bf8a50] dark:text-[#d6b56d]' : 'opacity-70'} />
              JSON Schema Spec
            </button>
            
            <div className="pt-4 pb-1 px-3">
              <p className="text-[9px] font-black uppercase tracking-widest text-[#a48e7a] dark:text-[#8a7b6b]">REST API Endpoints</p>
            </div>
            
            
            {apiGroups.map((group, groupIndex) => {
              const isExpanded = !!expandedGroups[group.groupName];
              
              return (
                <div key={group.groupName} className="mb-2">
                  <div 
                    className="sticky top-0 z-10 bg-[#f5eedf]/95 dark:bg-[#1e1914]/95 backdrop-blur-sm px-3 py-2 mb-1 cursor-pointer flex items-center justify-between rounded hover:bg-[#ebdcb9]/30 dark:hover:bg-[#292119]/80 transition-colors"
                    onClick={() => toggleGroup(group.groupName)}
                  >
                    <p className="text-[10px] font-bold text-[#8c7463] dark:text-[#b8ab9f] tracking-wide select-none">{group.groupName}</p>
                    {isExpanded ? <ChevronDown size={14} className="text-[#a48e7a] dark:text-[#8a7b6b]" /> : <ChevronRight size={14} className="text-[#a48e7a] dark:text-[#8a7b6b]" />}
                  </div>
                  {isExpanded && (
                    <div className="space-y-1 mb-4">
                      {group.endpoints.map((spec, specIndex) => {
                        const apiId = `api-${groupIndex}-${specIndex}`;
                        const isSelected = selectedItemId === apiId;
                        
                        return (
                          <button
                            key={apiId}
                            type="button"
                            onClick={() => setSelectedItemId(apiId)}
                            className={`w-full text-left px-3 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2.5 ${
                              isSelected
                                ? 'bg-white dark:bg-[#292119] shadow-sm ring-1 ring-[#ebdcb9] dark:ring-[#584a3b] text-[#5c493c] dark:text-[#f3eadf]'
                                : 'text-[#9e8470] dark:text-[#b8ab9f] hover:bg-white/50 dark:hover:bg-[#292119]/50 hover:text-[#5c493c] dark:hover:text-[#f3eadf]'
                            }`}
                          >
                            <span className={`text-[9px] font-black w-10 ${SIDEBAR_METHOD_COLORS[spec.method] || 'text-gray-500'}`}>
                              {spec.method}
                            </span>
                            <span className="truncate">{spec.path}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        
        {/* Right Content Pane */}
        <div className="flex-1 flex flex-col bg-[#fcfaf5] dark:bg-[#1e1914] min-w-0">
          <div className="px-6 py-5 border-b border-[#ebdcb9]/60 dark:border-[#584a3b]/60 flex items-center justify-between shrink-0">
            <h3 className="text-xs font-bold text-[#3c2a1a] dark:text-[#f3eadf] flex items-center gap-2">
              <span className="w-1.5 h-3 bg-[#ebdcb9] dark:bg-[#584a3b] rounded-full inline-block" />
              {selectedItemId === 'schema' 
                ? 'โครงสร้างข้อมูล JSON สำหรับนำเข้า/สำรองข้อมูล (Import Template)'
                : 'ข้อกำหนดและรายละเอียด Sandbox REST API (Active Specification)'}
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 dark:text-[#b8ab9f] hover:text-red-500 p-1.5 rounded-full hover:bg-white dark:hover:bg-[#292119]/60 transition-all cursor-pointer -my-1.5 -mr-1.5"
            >
              <X size={17} />
            </button>
          </div>
          
          <div className="flex-1 p-6 overflow-y-auto scrollbar-thin text-xs text-[#5c493c] dark:text-[#f3eadf]">
            {selectedItemId === 'schema' ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-[11px] text-[#7a6455] dark:text-[#f3eadf] leading-relaxed font-sans">
                    คุณสามารถแก้ไขรายการงานแบบกลุ่ม (Batch) เพื่อจัดการเอกสารล่วงหน้า บันทึกเป็นไฟล์ <code className="bg-[#f5eedf] dark:bg-[#1e1914] px-1.5 py-0.5 rounded border border-[#ebdcb9] dark:border-[#584a3b] font-mono text-[#aa7233] dark:text-[#f3eadf] text-[10px]">.json</code> แล้วนำเข้าผ่านปุ่ม <strong className="text-[#3c2a1a] dark:text-[#f3eadf]">Restore</strong> ด้านบนเพื่อเชื่อมโยงกับ API ทันที
                  </p>
                </div>

              <div className="space-y-1.5 bg-[#ffffff] dark:bg-[#1e1914] border border-[#f5ecd4] dark:border-[#584a3b] rounded-2xl overflow-hidden shadow-2xs">
                <div className="bg-[#f5eedf]/60 dark:bg-[#1e1914]/60 px-4 py-2 border-b border-[#f5ecd4] dark:border-[#584a3b] flex justify-between items-center text-[10px]">
                  <span className="text-[#715c4d] dark:text-[#f3eadf] font-mono font-bold">template-backlog.json</span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleDownload}
                      className="hover:text-[#3a2010] dark:hover:text-[#f3eadf] bg-white dark:bg-[#1e1914] border border-[#f5ecd4] dark:border-[#584a3b] px-2.5 py-1 rounded-xl cursor-pointer text-[#715c4d] dark:text-[#f3eadf] font-semibold flex items-center gap-1 transition-all"
                    >
                      <Download size={11} /> Download Template
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCopy(jsonString, 'schema')}
                      className={`border px-2.5 py-1 rounded-xl cursor-pointer font-semibold flex items-center gap-1 transition-all ${
                        copied && copiedText === 'schema'
                          ? 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-400'
                          : 'bg-white dark:bg-[#1e1914] border-[#f5ecd4] dark:border-[#584a3b] text-[#715c4d] dark:text-[#f3eadf] hover:text-[#3a2010] dark:hover:text-[#f3eadf]'
                      }`}
                    >
                      {copied && copiedText === 'schema' ? (
                        <>
                          <Check size={11} /> Copied!
                        </>
                      ) : (
                        <>
                          <Copy size={11} /> Copy JSON
                        </>
                      )}
                    </button>
                  </div>
                </div>
                
                <pre className="p-4 bg-[#fffcf7] dark:bg-[#1e1914] overflow-x-auto text-[11px] leading-relaxed text-[#a46c24] dark:text-[#f3eadf] font-mono scrollbar-thin max-h-[400px] font-semibold">
                  <code>{jsonString}</code>
                </pre>
              </div>

              <div className="border-t border-[#ebdcb9]/60 dark:border-[#584a3b]/60 pt-4 space-y-2 font-sans text-[11px] text-[#7a6455] dark:text-[#f3eadf] leading-relaxed">
                <p className="font-mono text-[9px] uppercase tracking-wider text-[#8a6e5a] dark:text-[#f3eadf] font-bold">ฟิลด์ที่สำคัญประกอบด้วย:</p>
                <ul className="list-disc list-inside space-y-1 pl-1">
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">id</strong>: คีย์หลักระบุแต่ละงาน ต้องไม่ซ้ำกัน</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">projectId</strong>: บังคับใช้ UUID ของโปรเจกต์ (Raw API ต้องใช้การฟิลด์นี้ ส่วนฝั่ง MCP จะอนุมานจาก <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">repo</code> หรือ <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">projectName</code> ได้)</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">status</strong>: สถานะบอร์ด <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">"backlog" | "todo" | "in-progress" | "ready-for-review" | "done"</code></li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">priority</strong>: ระดับความเร่งด่วน <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">"low" | "medium" | "high"</code></li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">targetFiles</strong>: รายชื่อพาธไฟล์ที่จะแก้ไขเกี่ยวข้อง</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">checklist</strong>: ขั้นตอนการทำงานที่ต้องทำ (executable work logic ควรอธิบายในนี้ อันที่จุกจิกๆ แทน description)</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">agent</strong>: เอเจนต์ที่รับผิดชอบ <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">"Codex" | "Antigravity" | "Claude"</code></li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">model</strong>: ชื่อโมเดล AI</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">effort</strong>: ระดับพละกำลัง (ต้องใช้คำตามที่ Agent/Model อนุญาตเท่านั้น) <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">"low" | "medium" | "high" | "xhigh"</code></li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">category</strong>: ประเภทงานหลักที่ต้องมีเสมอ ใช้ได้แค่ <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">frontend</code>, <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">backend</code>, หรือ <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">general</code></li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">tags</strong>: ป้ายกำกับเสริมแบบอิสระ เช่น <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">queue</code> หรือ <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">auto-work</code> และไม่ควรใช้ซ้ำกับ category</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">reasoning</strong>: เหตุผล/บริบทที่มาของงาน กรณีรวม FE/BE ไว้ใบเดียวให้ใช้ <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">general</code> และอธิบายเหตุผลให้ชัด</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">acceptanceCriteria</strong>: เกณฑ์การตรวจรับงาน (Acceptance Criteria)</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">verification</strong>: ขั้นตอนการตรวจสอบหรือทดสอบว่าเสร็จสมบูรณ์</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">repoContext</strong>: ข้อแนะนำโครงสร้างงาน, ปัญหาหรือจุดที่ต้องระวังเป็นพิเศษ (ห้ามใส่ URL, path, หรือ branch ซ้ำซ้อนที่นี่)</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">jiraKey</strong>: รหัสทิกเก็ต/งานบน Jira (เช่น QCA-3314)</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">repo</strong>: ลิงก์ไปย้ง Repository ที่เกี่ยวข้อง</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">sourceUrl</strong>: URL อ้างอิงต้นทางของตั๋วงาน</li>
                </ul>
              </div>
            </div>
          ) : (
            <div key={selectedItemId} className="space-y-6 animate-fade-in">
              <div className="space-y-2">
                <p className="text-[11px] text-[#7a6455] dark:text-[#f3eadf] leading-relaxed font-sans">
                  แอปพลิเคชันทำงานแบบ Sandbox Fullstack ร่วมกับ Node.js / Express Server ของหลังบ้านพอร์ต 3000 ด้านล่างนี้คือ API Endpoints ทั้งหมดที่คุณสามารถจำลองการส่ง HTTP Requests ไปเชื่อมต่อหรือจำลองพอร์ตเพื่อดูผลได้
                </p>
              </div>

              <div className="space-y-4">
                {apiSpecsWithIds
                  .filter((api) => api.id === selectedItemId)
                  .map((api) => (
                    <div key={api.id} className="bg-white dark:bg-[#1e1914] border border-[#f5ecd4] dark:border-[#584a3b] rounded-2xl overflow-hidden shadow-3xs flex flex-col">
                      {/* Sub-header with Method & Path */}
                      <div className="bg-[#fcfaf5] dark:bg-[#1e1914] border-b border-[#f5ecd4] dark:border-[#584a3b] px-4 py-2.5 flex items-center justify-between font-mono">
                        <div className="flex items-center gap-2.5">
                          <span className={`px-2 py-0.5 rounded-lg border text-[9.5px] font-black tracking-wide ${PANE_METHOD_COLORS[api.method] || 'bg-gray-100 dark:bg-[#1e1914]'}`}>
                            {api.method}
                          </span>
                          <span className="text-[11.5px] font-bold text-[#3c2a1a] dark:text-[#f3eadf]">{api.path}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleCopy(api.example, api.id)}
                          className={`text-[9.5px] border px-2 py-0.5 rounded-lg font-bold cursor-pointer transition-colors ${
                            copied && copiedText === api.id
                              ? 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-800/50 text-emerald-800 dark:text-emerald-400'
                              : 'bg-white dark:bg-[#1e1914] border-[#f5ecd4] dark:border-[#584a3b] text-[#7a6455] dark:text-[#f3eadf] hover:text-[#3c2a1a] dark:hover:text-[#f3eadf]'
                          }`}
                        >
                          {copied && copiedText === api.id ? 'Copied script!' : 'Copy Code'}
                        </button>
                      </div>

                      {/* Info & Payload info */}
                      <div className="p-4 space-y-3 font-mono text-[10.5px]">
                        <div>
                          <p className="text-[#8c7463] dark:text-[#f3eadf] font-bold text-[9px] uppercase tracking-wider mb-0.5">Description:</p>
                          <p className="text-[#3c2a1a] dark:text-[#f3eadf] font-sans text-xs leading-relaxed">{api.description}</p>
                        </div>

                        {api.payload && (
                          <div>
                            <p className="text-[#8c7463] dark:text-[#f3eadf] font-bold text-[9px] uppercase tracking-wider mb-1">Request Body (JSON):</p>
                            <pre className="p-2.5 bg-[#fffcf7] dark:bg-[#1e1914] border border-[#f5ecd4] dark:border-[#584a3b] rounded-xl overflow-x-auto text-[10px] text-[#aa7233] dark:text-[#f3eadf] leading-relaxed scrollbar-thin">
                              <code>{api.payload}</code>
                            </pre>
                          </div>
                        )}

                                                <div>
                          <p className="text-[#8c7463] dark:text-[#f3eadf] font-bold text-[9px] uppercase tracking-wider mb-0.5">Expected Response:</p>
                          <p className="text-[#554030] dark:text-[#f3eadf] bg-[#fffcf7] dark:bg-[#1e1914] px-2.5 py-1 rounded-lg border border-[#f5ecd4] dark:border-[#584a3b] font-semibold">{api.response}</p>
                          {(api as any).responseExample && (
                            <div className="mt-1.5">
                              <pre className="p-2.5 bg-[#fffcf7] dark:bg-[#1e1914] border border-[#f5ecd4] dark:border-[#584a3b] rounded-xl overflow-x-auto text-[10px] text-[#aa7233] dark:text-[#f3eadf] leading-relaxed scrollbar-thin">
                                <code>{(api as any).responseExample}</code>
                              </pre>
                            </div>
                          )}
                        </div>

                        <div>
                          <p className="text-[#8c7463] dark:text-[#f3eadf] font-bold text-[9px] uppercase tracking-wider mb-1">Code Pattern Example (Fetch JS):</p>
                          <pre className="p-2.5 bg-[#1e293b] dark:bg-[#292119] text-[#38bdf8] dark:text-[#d6b56d] rounded-xl overflow-x-auto font-mono text-[10px] leading-relaxed">
                            <code>{api.example}</code>
                          </pre>
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
