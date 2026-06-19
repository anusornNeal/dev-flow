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
        response: 'JSON Array ของ Tasks ทั้งหมด',
        responseExample: `[
  {
    "id": "task-abc123xyz",
    "displayId": "DVF-0001",
    "projectId": "proj-xyz789",
    "title": "Setup Authentication API",
    "status": "in-progress"
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
  "type": "object",
  "properties": {}
}`,
        example: 'fetch(\'/api/schema/task\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id',
        description: 'เรียกดูการ์ดงานชิ้นใดชิ้นหนึ่งด้วย ID',
        response: 'JSON Object ของ Task',
        responseExample: `{
  "id": "task-abc123xyz",
  "title": "Setup Authentication API",
  "status": "in-progress"
}`,
        example: 'fetch(\'/api/tasks/task-1\').then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks',
        description: 'สร้างตั๋วงานเดี่ยว หรือนำเข้าการ์ดแบบกลุ่ม (Bulk Import)',
        payload: `{
  "projectId": "UUID ของโปรเจกต์ (Required)",
  "tasks": [ { "title": "Backend API" } ]
}`,
        response: 'JSON Object แสดงสถิติจำนวน { success, createdCount, updatedCount, tasks }',
        responseExample: `{
  "success": true,
  "createdCount": 1,
  "updatedCount": 0,
  "tasks": []
}`,
        example: 'fetch(\'/api/tasks\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ projectId: \'proj-1\', tasks: [{title: \'Test\'}] }) }).then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/tasks',
        description: 'เขียนและอัปเดตบันทึกการ์ดงานพร้อมกันแบบกลุ่ม (Batch Upsert)',
        payload: `{ "projectId": "...", "tasks": [] }`,
        response: 'JSON Object ยืนยันสถานะการอัปเดตแบบกลุ่ม',
        responseExample: `{
  "success": true,
  "createdCount": 0,
  "updatedCount": 1,
  "tasks": []
}`,
        example: 'fetch(\'/api/tasks\', { method: \'PUT\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ projectId: \'proj-1\', tasks: [] }) }).then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/tasks/:id',
        description: 'อัปเดตข้อมูลย่อยของการ์ดงาน เช่น เปลี่ยนสถานะเลน, แก้ไข checklist',
        payload: `{ "status": "in-progress", "priority": "high" }`,
        response: 'JSON Object ของ Task ที่ผ่านการอัปเดตเรียบร้อย',
        responseExample: `{ "id": "task-abc123xyz", "status": "in-progress" }`,
        example: 'fetch(\'/api/tasks/task-1\', { method: \'PUT\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ status: \'in-progress\' }) }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/tasks/:id',
        description: 'ลบการ์ดงานชิ้นนั้นๆ อ้างอิงจาก ID อย่างถาวร',
        response: '{ "success": true, "removed": { ... } }',
        responseExample: `{ "success": true, "removed": { "id": "task-abc123xyz" } }`,
        example: 'fetch(\'/api/tasks/task-1\', { method: \'DELETE\' }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/batch',
        description: 'อัปเดตและสร้างบันทึกการ์ดงานพร้อมกันแบบกลุ่ม',
        payload: `{ "projectId": "...", "tasks": [] }`,
        response: 'JSON Object',
        responseExample: `{ "success": true, "updatedCount": 2 }`,
        example: 'fetch(\'/api/tasks/batch\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ projectId: \'proj-1\', tasks: [] }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/batch/move',
        description: 'ย้ายสถานะเลนการทำงานของการ์ดแบบกลุ่ม',
        payload: `{ "taskIds": ["id1", "id2"], "status": "done" }`,
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/tasks/batch/move\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ taskIds: [\'1\'], status: \'done\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/batch/checklist/toggle',
        description: 'สลับสถานะความสำเร็จของข้อกำหนด Checklist แบบกลุ่ม',
        payload: `{ "taskIds": ["id1"], "checklistId": "step-1" }`,
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/tasks/batch/checklist/toggle\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ taskIds: [\'1\'], checklistId: \'step\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/batch/assign',
        description: 'มอบหมาย Agent แบบกลุ่ม',
        payload: `{ "taskIds": ["id1"], "agent": "Antigravity" }`,
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/tasks/batch/assign\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ taskIds: [\'1\'], agent: \'Antigravity\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/move',
        description: 'ย้ายสถานะเลนการทำงานของการ์ดชิ้นหนึ่งๆ',
        payload: `{ "status": "done" }`,
        response: 'JSON Object สถานะตอบกลับ',
        responseExample: `{ "success": true, "task": { "id": "task-abc123xyz" } }`,
        example: 'fetch(\'/api/tasks/task-1/move\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ status: \'done\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/checklist/toggle',
        description: 'สลับสถานะความสำเร็จของข้อกำหนด Checklist item',
        payload: `{ "checklistId": "step-1-1" }`,
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/tasks/task-1/checklist/toggle\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ checklistId: \'s-1\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/assign',
        description: 'มอบหมาย Agent',
        payload: `{ "agent": "Antigravity" }`,
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/tasks/task-1/assign\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ agent: \'Codex\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/import-file',
        description: 'นำเข้าตั๋วงานจากไฟล์ .json หรือ .md',
        payload: 'FormData (multipart/form-data) บรรจุไฟล์',
        response: 'JSON Object แสดงจำนวนที่ถูก import',
        responseExample: `{ "success": true, "createdCount": 5 }`,
        example: 'fetch(\'/api/tasks/import-file\', { method: \'POST\', body: new FormData() }).then(res => res.json());'
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
        response: 'JSON Object บรรจุ String ของ Prompt',
        responseExample: `{ "prompt": "You are Antigravity..." }`,
        example: 'fetch(\'/api/tasks/task-1/prompt\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id/agent-context',
        description: 'ดึงข้อมูล Context ล่าสุดเพื่อเตรียมรัน Agent',
        response: 'JSON Object ของ Context',
        responseExample: `{ "repoUrl": "...", "branch": "main" }`,
        example: 'fetch(\'/api/tasks/task-1/agent-context\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id/agent-runs',
        description: 'ดึงประวัติการรัน Agent ทั้งหมดของ Task',
        response: 'JSON Array',
        responseExample: `[{ "id": "run-1", "status": "completed" }]`,
        example: 'fetch(\'/api/tasks/task-1/agent-runs\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id/agent-runs/:runId/history',
        description: 'ดึงประวัติการสนทนาและ Message History ของการรัน Agent',
        response: 'JSON Array',
        responseExample: `[{ "role": "user", "content": "..." }]`,
        example: 'fetch(\'/api/tasks/task-1/agent-runs/run-1/history\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id/agent-runs/:runId/log',
        description: 'ดึงข้อมูลบันทึกการทำงาน (Log) ของ Agent ที่รันผ่าน Task นี้',
        response: 'Text String แสดง Log การทำงาน',
        responseExample: `[INFO] Agent started processing task DVF-0001
[INFO] Generated implementation plan`,
        example: 'fetch(\'/api/tasks/task-1/agent-runs/run-123/log\').then(res => res.text());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/agent-runs/retry',
        description: 'สั่ง Retry การรัน Agent ที่ล้มเหลว',
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/tasks/task-1/agent-runs/retry\', { method: \'POST\' }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/agent-runs/cancel',
        description: 'สั่ง Cancel การรัน Agent ปัจจุบัน',
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/tasks/task-1/agent-runs/cancel\', { method: \'POST\' }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/agent-complete',
        description: 'แจ้งสถานะ Complete จากตัว Agent โดยตรงเพื่ออัปเดต Task',
        payload: `{ "status": "success", "summary": "Finished UI" }`,
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/tasks/task-1/agent-complete\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ status: \'success\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/agent-runs/:runId/complete',
        description: 'แจ้งสถานะ Complete ระบุตาม Run ID',
        payload: `{ "status": "success" }`,
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/tasks/task-1/agent-runs/run-1/complete\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ status: \'success\' }) }).then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/prompt-template/sections',
        description: 'ดึงหัวข้อ Prompt Template ทั้งหมด',
        response: 'JSON Array',
        responseExample: `[{ "id": "sys-prompt", "content": "..." }]`,
        example: 'fetch(\'/api/prompt-template/sections\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/prompt-template/section',
        description: 'ดึงเนื้อหา Prompt Template ล่าสุดตาม Section ID',
        response: 'JSON Object',
        responseExample: `{ "content": "..." }`,
        example: 'fetch(\'/api/prompt-template/section?id=sys-prompt\').then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/prompt-template/section',
        description: 'อัปเดตเนื้อหา Prompt Template',
        payload: `{ "id": "sys-prompt", "content": "New content" }`,
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/prompt-template/section\', { method: \'PUT\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ id: \'sys\', content: \'hi\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/prompt-template/preview',
        description: 'ดูตัวอย่างผลลัพธ์ของ Prompt (Preview)',
        payload: `{ "template": "...", "variables": {} }`,
        response: 'JSON Object',
        responseExample: `{ "preview": "Hello World" }`,
        example: 'fetch(\'/api/prompt-template/preview\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ template: \'hi\' }) }).then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/prompt-overrides/sections',
        description: 'ดึงข้อมูล Overrides ของ Prompt',
        response: 'JSON Array',
        responseExample: `[]`,
        example: 'fetch(\'/api/prompt-overrides/sections\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/prompt-overrides/section',
        description: 'ดึง override ของ section หนึ่ง',
        response: 'JSON Object',
        responseExample: `{}`,
        example: 'fetch(\'/api/prompt-overrides/section?id=sys\').then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/prompt-overrides/section',
        description: 'อัปเดต override ของ section หนึ่ง',
        payload: `{ "id": "section1", "overrideContent": "..." }`,
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/prompt-overrides/section\', { method: \'PUT\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ id: \'sys\' }) }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/prompt-overrides/section',
        description: 'ลบ override เพื่อกลับไปใช้ค่า Default',
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/prompt-overrides/section?id=sys\', { method: \'DELETE\' }).then(res => res.json());'
      }
    ]
  },
  {
    groupName: 'Projects',
    endpoints: [
      {
        method: 'GET',
        path: '/api/projects',
        description: 'เรียกดูรายการโปรเจกต์ทั้งหมดในระบบ',
        response: 'JSON Array ของ Projects ทั้งหมด',
        responseExample: `[
  {
    "id": "proj-xyz789",
    "name": "DevFlow Sandbox",
    "repoUrl": "https://github.com/my/dev-flow-sandbox"
  }
]`,
        example: 'fetch(\'/api/projects\').then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/projects',
        description: 'สร้างโปรเจกต์ใหม่เพื่อใช้ผูกกับการ์ดงาน',
        payload: `{ "name": "ชื่อโปรเจกต์", "repoUrl": "URL ของ Repository" }`,
        response: 'JSON Object ของ Project ที่สร้างเสร็จ',
        responseExample: `{
  "id": "proj-xyz789",
  "name": "DevFlow Sandbox",
  "repoUrl": "https://github.com/my/dev-flow-sandbox"
}`,
        example: 'fetch(\'/api/projects\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ name: \'Test\' }) }).then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/projects/:id',
        description: 'อัปเดตข้อมูลโปรเจกต์ เช่น เปลี่ยนชื่อ หรือ URL',
        payload: `{ "name": "DevFlow V2" }`,
        response: 'JSON Object ของ Project ที่อัปเดตเสร็จ',
        responseExample: `{
  "id": "proj-xyz789",
  "name": "DevFlow V2"
}`,
        example: 'fetch(\'/api/projects/proj-1\', { method: \'PUT\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ name: \'Test\' }) }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/projects',
        description: 'ลบข้อมูล Project แบบกลุ่ม',
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/projects\', { method: \'DELETE\' }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/projects/:id',
        description: 'ลบโปรเจกต์พร้อมตั๋วงานที่ผูกกับโปรเจกต์นั้นอย่างถาวร',
        response: '{ "success": true, "removedId": "project-id" }',
        responseExample: `{
  "success": true,
  "removedId": "proj-xyz789"
}`,
        example: 'fetch(\'/api/projects/proj-1\', { method: \'DELETE\' }).then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/projects/:id/prompt-sections',
        description: 'ดึง Prompt Sections สำหรับ Project หนึ่ง',
        response: 'JSON Array',
        responseExample: `[]`,
        example: 'fetch(\'/api/projects/proj-1/prompt-sections\').then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/projects/:id/prompt-overrides/:sectionId',
        description: 'อัปเดต Prompt Override ของ Project เฉพาะ',
        payload: `{ "content": "..." }`,
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/projects/proj-1/prompt-overrides/sys\', { method: \'PUT\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ content: \'hi\' }) }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/projects/:id/prompt-overrides/:sectionId',
        description: 'ลบ Prompt Override ของ Project เฉพาะ',
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/projects/proj-1/prompt-overrides/sys\', { method: \'DELETE\' }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/projects/:id/prompt-preview',
        description: 'Preview Prompt ภายในบริบทของ Project',
        payload: `{ "variables": {} }`,
        response: 'JSON Object',
        responseExample: `{ "preview": "..." }`,
        example: 'fetch(\'/api/projects/proj-1/prompt-preview\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ variables: {} }) }).then(res => res.json());'
      }
    ]
  },
  {
    groupName: 'Skills',
    endpoints: [
      {
        method: 'GET',
        path: '/api/skills',
        description: 'ดึงรายการ Skills ทั้งหมด',
        response: 'JSON Array',
        responseExample: `[{ "id": "react-skill", "name": "React" }]`,
        example: 'fetch(\'/api/skills\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/skills/authoring',
        description: 'ดึงรายการ Authoring Skills (ผู้แต่ง)',
        response: 'JSON Array',
        responseExample: `[]`,
        example: 'fetch(\'/api/skills/authoring\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/skills/:id',
        description: 'ดึงรายละเอียด Skill ด้วย ID',
        response: 'JSON Object',
        responseExample: `{ "id": "react-skill" }`,
        example: 'fetch(\'/api/skills/react-skill\').then(res => res.json());'
      },
      {
        method: 'PUT',
        path: '/api/skills/:id',
        description: 'อัปเดตข้อมูล Skill',
        payload: `{ "description": "..." }`,
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/skills/react-skill\', { method: \'PUT\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ description: \'desc\' }) }).then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/skills/import',
        description: 'Import Skill ใหม่เข้าระบบ',
        payload: `{ "url": "github.com/..." }`,
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/skills/import\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ url: \'url\' }) }).then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/skills/:id',
        description: 'ลบ Skill ออกจากระบบ',
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/skills/react-skill\', { method: \'DELETE\' }).then(res => res.json());'
      }
    ]
  },
  {
    groupName: 'Attachments & Media',
    endpoints: [
      {
        method: 'GET',
        path: '/api/tasks/:taskId/attachments',
        description: 'ดึงไฟล์แนบทั้งหมดของการ์ดงาน',
        response: 'JSON Array',
        responseExample: `[{ "id": "att-1", "filename": "doc.pdf" }]`,
        example: 'fetch(\'/api/tasks/task-1/attachments\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/attachments/:attachmentId',
        description: 'ดึงข้อมูลหรือไฟล์แนบ 1 ไฟล์ด้วย ID',
        response: 'File Stream หรือ JSON',
        responseExample: `{ "id": "att-1", "url": "..." }`,
        example: 'fetch(\'/api/attachments/att-1\').then(res => res.json());'
      },
      {
        method: 'DELETE',
        path: '/api/attachments/:attachmentId',
        description: 'ลบไฟล์แนบตาม ID',
        response: 'JSON Object',
        responseExample: `{ "success": true }`,
        example: 'fetch(\'/api/attachments/att-1\', { method: \'DELETE\' }).then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/tasks/:id/images',
        description: 'ดึงรูปภาพทั้งหมดที่แนบไว้กับตั๋วงาน',
        response: 'JSON Array ของรูปภาพ',
        responseExample: `[{ "id": "img-1", "url": "/api/static/images/img.png" }]`,
        example: 'fetch(\'/api/tasks/task-1/images\').then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/images/upload',
        description: 'อัปโหลดรูปภาพเพื่อนำไปใช้แนบในการ์ดงาน',
        payload: 'FormData (multipart/form-data) บรรจุไฟล์รูปภาพ',
        response: '{ "success": true, "url": "..." }',
        responseExample: `{
  "success": true,
  "url": "/api/static/images/img-1781830891307-1b8f1f69.png"
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
        response: 'JSON Object แสดง Flags',
        responseExample: `{ "git": true, "fs": true }`,
        example: 'fetch(\'/api/capabilities\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/local-files',
        description: 'List ไฟล์ในระบบ Local Directory ของโปรเจกต์',
        response: 'JSON Array ของ Paths',
        responseExample: `["src/index.ts", "package.json"]`,
        example: 'fetch(\'/api/local-files?path=src\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/local-files/read',
        description: 'อ่านเนื้อหาไฟล์ใน Local Directory',
        response: 'Text String',
        responseExample: `console.log("Hello World");`,
        example: 'fetch(\'/api/local-files/read?path=src/index.ts\').then(res => res.text());'
      },
      {
        method: 'GET',
        path: '/api/local-files/search',
        description: 'ค้นหาเนื้อหาภายในไฟล์ต่างๆ',
        response: 'JSON Array ของผลลัพธ์',
        responseExample: `[{ "file": "src/index.ts", "line": 1, "content": "..." }]`,
        example: 'fetch(\'/api/local-files/search?q=import\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/git/log',
        description: 'ดึง Git Log History',
        response: 'JSON Array ของ Commits',
        responseExample: `[{ "hash": "abc1234", "message": "Initial commit" }]`,
        example: 'fetch(\'/api/git/log\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/git/diff',
        description: 'ดึง Git Diff ที่มีอยู่',
        response: 'Text String ของ Diff Patch',
        responseExample: `diff --git a/index.ts b/index.ts...`,
        example: 'fetch(\'/api/git/diff\').then(res => res.text());'
      },
      {
        method: 'GET',
        path: '/api/git/show',
        description: 'ดึงข้อมูลรายละเอียด Commit ด้วย hash (git show)',
        response: 'Text String',
        responseExample: `commit abc1234...`,
        example: 'fetch(\'/api/git/show?hash=abc1234\').then(res => res.text());'
      },
      {
        method: 'GET',
        path: '/api/git/status',
        description: 'ดึงสถานะ Git ปัจจุบัน (git status)',
        response: 'JSON Object ของสถานะ',
        responseExample: `{ "branch": "main", "isClean": false }`,
        example: 'fetch(\'/api/git/status\').then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/git/branch',
        description: 'ดึงข้อมูลสาขา Git (Branch)',
        response: 'JSON Array ของ Branches',
        responseExample: `["main", "feature/auth"]`,
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
        description: 'ดึงการตั้งค่าของแอปพลิเคชันและผู้ใช้ (เช่น AI Model, API Keys)',
        response: 'JSON Object แสดง Settings ทั้งหมด',
        responseExample: `{
  "aiModel": "Antigravity",
  "apiKey": "sk-1234567890abcdef1234567890abcdef"
}`,
        example: 'fetch(\'/api/settings\').then(res => res.json());'
      },
      {
        method: 'POST',
        path: '/api/settings',
        description: 'บันทึกและอัปเดตการตั้งค่าแอปพลิเคชัน',
        payload: `{ "aiModel": "Antigravity", "apiKey": "sk-1234" }`,
        response: 'JSON Object ของ Settings ที่อัปเดตแล้ว',
        responseExample: `{
  "aiModel": "Antigravity",
  "apiKey": "sk-1234567890abcdef1234567890abcdef"
}`,
        example: 'fetch(\'/api/settings\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ aiModel: \'Antigravity\' }) }).then(res => res.json());'
      },
      {
        method: 'GET',
        path: '/api/export',
        description: 'ส่งออกข้อมูลทั้งหมดในระบบ (Export)',
        response: 'JSON File Stream',
        responseExample: `{ "tasks": [], "projects": [] }`,
        example: 'window.open(\'/api/export\', \'_blank\');'
      },
      {
        method: 'POST',
        path: '/api/import',
        description: 'นำเข้าข้อมูลที่ถูก Backup ไว้เพื่อกู้คืน (Import/Restore)',
        payload: 'Raw JSON Buffer',
        response: 'JSON Object ของผลลัพธ์',
        responseExample: `{ "success": true, "message": "Restored" }`,
        example: 'fetch(\'/api/import\', { method: \'POST\', body: jsonBuffer }).then(res => res.json());'
      }
    ]
  }
];

const apiSpecsWithIds = apiGroups.flatMap((group, groupIndex) => 
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
