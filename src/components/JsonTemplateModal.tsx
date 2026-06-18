/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, Copy, Check, Download, FileCode } from 'lucide-react';
import { getAgentCatalogHelp, getValidAgentModelEffortExamples, getInvalidAgentModelEffortExamples } from '../lib/agentsConfig';

const SIDEBAR_METHOD_COLORS: Record<string, string> = {
  GET: 'text-emerald-600 dark:text-emerald-400',
  POST: 'text-blue-600 dark:text-blue-400',
  PUT: 'text-amber-600 dark:text-amber-400',
  DELETE: 'text-rose-600 dark:text-rose-400',
};

const PANE_METHOD_COLORS: Record<string, string> = {
  GET: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  POST: 'bg-blue-50 text-blue-700 border-blue-200',
  PUT: 'bg-amber-50 text-amber-700 border-amber-200',
  DELETE: 'bg-rose-50 text-rose-700 border-rose-200',
};

const sampleJson = [
  {
    "id": "spec-backend-101",
    "projectId": "YOUR_PROJECT_UUID_HERE",
    "title": "Setup Authentication API with Bearer Tokens",
    "description": "Create the backend authentication endpoints.\n\nProblem: We lack secure token validation.\nExpected: All protected routes validate JWTs using Argon2 and return 401 if missing.",
    "status": "todo",
    "priority": "high",
    "tags": ["backend", "api", "security"],
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
    "tags": ["frontend", "auth"],
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

const apiSpecs = [
  {
    method: 'GET',
    path: '/api/projects',
    description: 'เรียกดูรายการโปรเจกต์ทั้งหมดในระบบ',
    response: 'JSON Array ของ Projects ทั้งหมด',
    example: 'fetch(\'/api/projects\').then(res => res.json());'
  },
  {
    method: 'POST',
    path: '/api/projects',
    description: 'สร้างโปรเจกต์ใหม่เพื่อใช้ผูกกับการ์ดงาน',
    payload: '{\n  "name": "ชื่อโปรเจกต์",\n  "repoUrl": "URL ของ Repository",\n  "description": "รายละเอียดเพิ่มเติม"\n}',
    response: 'JSON Object ของ Project ที่สร้างเสร็จ',
    example: 'fetch(\'/api/projects\', {\n  method: \'POST\',\n  headers: { \'Content-Type\': \'application/json\' },\n  body: JSON.stringify({ name: \'DevFlow\', repoUrl: \'https://github.com/my/repo\' })\n}).then(res => res.json());'
  },
  {
    method: 'DELETE',
    path: '/api/projects/:id',
    description: 'ลบโปรเจกต์พร้อมตั๋วงานที่ผูกกับโปรเจกต์นั้นอย่างถาวร',
    response: '{ "success": true, "removedId": "project-id" }',
    example: 'fetch(\'/api/projects/project-123\', {\n  method: \'DELETE\'\n}).then(res => res.json());'
  },
  {
    method: 'POST',
    path: '/api/tasks',
    description: 'สร้างตั๋วงานเดี่ยว หรือนำเข้าการ์ดแบบกลุ่ม (Bulk Import) รองรับการสร้างตั๋วแยกย่อย (เช่น Frontend/Backend split) จาก Jira ใบเดียว',
    payload: '{\n  "projectId": "UUID ของโปรเจกต์ (Required สำหรับ Raw API. หากใช้ MCP tool สามารถส่ง repo/projectName แทนได้)",\n  "tasks": [\n    {\n      "title": "Backend API",\n      "tags": ["backend"]\n    },\n    {\n      "title": "Frontend UI",\n      "tags": ["frontend"]\n    }\n  ]\n}',
    response: 'JSON Object แสดงสถิติจำนวน { success: true, createdCount: number, updatedCount: number, tasks: Array }',
    example: 'fetch(\'/api/tasks\', {\n  method: \'POST\',\n  headers: { \'Content-Type\': \'application/json\' },\n  body: JSON.stringify({\n    projectId: \'project-uuid-123\',\n    tasks: [\n      { title: \'BE: Add API\' },\n      { title: \'FE: Call API\' }\n    ]\n  })\n}).then(res => res.json());'
  },
  {
    method: 'POST',
    path: '/api/tasks/batch',
    description: 'อัปเดตและสร้างบันทึกการ์ดงานพร้อมกันแบบกลุ่ม (Batch List Update/Upsert)',
    payload: '{\n  "projectId": "UUID ของโปรเจกต์ (Required สำหรับ Raw API)",\n  "tasks": [\n    {\n      "id": "task-old (ใส่กรณีต้องการแก้ใบเดิม)",\n      "title": "ชื่องานอัปเดต"\n    }\n  ]\n}',
    response: 'JSON Object ยืนยันสถานะการอัปเดตแบบกลุ่ม { success: true, createdCount: number, updatedCount: number, tasks: Array }',
    example: 'fetch(\'/api/tasks/batch\', {\n  method: \'POST\',\n  headers: { \'Content-Type\': \'application/json\' },\n  body: JSON.stringify({\n    projectId: \'project-uuid-123\',\n    tasks: [\n      { title: \'Task 1 via outer POST batch\' },\n      { id: \'task-1\', status: \'done\' }\n    ]\n  })\n}).then(res => res.json());'
  },
  {
    method: 'PUT',
    path: '/api/tasks',
    description: 'เขียนและอัปเดตบันทึกการ์ดงานพร้อมกันแบบกลุ่ม (Batch List Update/Upsert) - พฤติกรรมเหมือน /api/tasks/batch',
    payload: '{\n  "projectId": "UUID ของโปรเจกต์ (Required สำหรับ Raw API)",\n  "tasks": [\n    {\n      "id": "task-old (ใส่กรณีต้องการแก้ใบเดิม)",\n      "title": "ชื่องานอัปเดต"\n    }\n  ]\n}',
    response: 'JSON Object ยืนยันสถานะการอัปเดตแบบกลุ่ม { success: true, createdCount: number, updatedCount: number, tasks: Array }',
    example: 'fetch(\'/api/tasks\', {\n  method: \'PUT\',\n  headers: { \'Content-Type\': \'application/json\' },\n  body: JSON.stringify({\n    projectId: \'project-uuid-123\',\n    tasks: [\n      { title: \'Task 1 via outer PUT\' },\n      { id: \'task-1\', status: \'done\' }\n    ]\n  })\n}).then(res => res.json());'
  },
  {
    method: 'POST',
    path: '/api/tasks/:id/move',
    description: 'ย้ายสถานะเลนการทำงานของการ์ดชิ้นหนึ่งๆ (ไม่ต้องส่งข้อมูลชิ้นเต็มก้อน)',
    payload: '{\n  "status": "backlog" | "todo" | "in-progress" | "ready-for-review" | "done"\n}',
    response: 'JSON Object สถานะตอบกลับ พร้อม Object ของ Task ที่อัปเดตแล้ว',
    example: 'fetch(\'/api/tasks/task-1/move\', {\n  method: \'POST\',\n  headers: { \'Content-Type\': \'application/json\' },\n  body: JSON.stringify({ status: \'in-progress\' })\n}).then(res => res.json());'
  },
  {
    method: 'POST',
    path: '/api/tasks/:id/checklist/toggle',
    description: 'สลับสถานะความสำเร็จของข้อกำหนด Checklist item ย่อยระบุโดย ID (ไม่ต้องส่งข้อมูลชิ้นเต็มก้อน)',
    payload: '{\n  "checklistId": "ชื่อรหัสของเช็คลิสต์ย่อยเดี่ยวๆ (Required Example: step-1-1)"\n}',
    response: 'JSON Object ของ Task บรรจุสถานะ Checklist ใหม่',
    example: 'fetch(\'/api/tasks/task-1/checklist/toggle\', {\n  method: \'POST\',\n  headers: { \'Content-Type\': \'application/json\' },\n  body: JSON.stringify({ checklistId: \'step-1-1\' })\n}).then(res => res.json());'
  },
  {
    method: 'POST',
    path: '/api/tasks/:id/assign',
    description: 'มอบหมาย Agent ผู้รับผิดชอบ หรือกำหนด AI Spec และพละกำลังความเพียรประมวลผลเดี่ยวๆ ทันที',
    payload: `{\n  "agent": "Codex" | "Antigravity" | "Claude" (Optional),\n  "model": "ชื่อโมเดล AI Spec (Optional)",\n  "effort": ${getAgentCatalogHelp()} (Optional)\n}`,
    response: 'JSON Object ของ Task อัปเดตข้อมูลผู้รับมอบหมายเรียบร้อยแล้ว',
    example: `// Valid examples:\n${getValidAgentModelEffortExamples().map(e => `// ${e}`).join('\n')}\n\n// Invalid examples:\n${getInvalidAgentModelEffortExamples().map(e => `// ${e}`).join('\n')}\n\nfetch('/api/tasks/task-1/assign', {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify({\n    agent: 'Codex',\n    model: 'GPT-5.4',\n    effort: 'xhigh'\n  })\n}).then(res => res.json());`
  },
  {
    method: 'GET',
    path: '/api/tasks',
    description: 'เรียกดูรายการการ์ดงาน (Tickets) ทั้งหมดในระบบ sandbox',
    response: 'JSON Array ของ Tasks ทั้งหมด',
    example: 'fetch(\'/api/tasks\')\n  .then(res => res.json())\n  .then(data => console.log(data));'
  },
  {
    method: 'PUT',
    path: '/api/tasks/:id',
    description: 'อัปเดตข้อมูลย่อยของการ์ดงาน เช่น เปลี่ยนสถานะเลน, แก้ไข checklist, เพิ่ม logs หรือบันทึกโน้ต',
    payload: `{\n  "status": "in-progress",\n  "priority": "high",\n  "checklist": [...],\n  "agent": "Codex" | "Antigravity" | "Claude" (Optional),\n  "model": "ชื่อโมเดล AI Spec (Optional)",\n  "effort": ${getAgentCatalogHelp()} (Optional),\n  "logs": [...]\n}`,
    response: 'JSON Object ของ Task ที่ผ่านการอัปเดตเรียบร้อย',
    example: 'fetch(\'/api/tasks/task-1\', {\n  method: \'PUT\',\n  headers: { \'Content-Type\': \'application/json\' },\n  body: JSON.stringify({ status: \'done\' })\n}).then(res => res.json());'
  },
  {
    method: 'DELETE',
    path: '/api/tasks/:id',
    description: 'ลบการ์ดงานชิ้นนั้นๆ อ้างอิงจาก ID อย่างถาวร',
    response: '{ "success": true, "removed": { ... } }',
    example: 'fetch(\'/api/tasks/task-1\', {\n  method: \'DELETE\'\n}).then(res => res.json());'
  },
  {
    method: 'GET',
    path: '/api/schema/task',
    description: 'ดึงโครงสร้าง JSON Schema ของข้อมูลการ์ดงาน (Task) ที่ระบุ Type ของทุกฟิลด์ และ Enum ค่อนข้างครบถ้วน',
    response: 'JSON Schema Definition Object',
    example: 'fetch(\'/api/schema/task\').then(res => res.json()).then(schema => console.log(schema));'
  }
];

const apiSpecsWithIds = apiSpecs.map((spec, index) => ({
  ...spec,
  id: `api-${index}`
}));

interface JsonTemplateModalProps {
  onClose: () => void;
}

export default function JsonTemplateModal({ onClose }: JsonTemplateModalProps) {
  const [selectedItemId, setSelectedItemId] = useState<string>('schema');
  const [copied, setCopied] = useState(false);
  const [copiedText, setCopiedText] = useState('');

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

      <div className="bg-[#fcfaf5]/80 dark:bg-[#1e1914]/80 backdrop-blur-xl border border-[#ebdcb9] dark:border-[#584a3b] w-full max-w-5xl rounded-3xl shadow-2xl relative z-10 overflow-hidden flex font-sans max-h-[85vh]">
        {/* Close button absolute top right */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 z-50 text-gray-400 dark:text-[#b8ab9f] hover:text-red-500 p-1.5 rounded-full hover:bg-white dark:hover:bg-[#292119]/60 transition-all cursor-pointer"
        >
          <X size={17} />
        </button>
        
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
            
            {apiSpecsWithIds.map((api) => {
              const isSelected = selectedItemId === api.id;
              
              return (
                <button
                  key={api.id}
                  onClick={() => setSelectedItemId(api.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2.5 ${
                    isSelected
                      ? 'bg-white dark:bg-[#292119] shadow-sm ring-1 ring-[#ebdcb9] dark:ring-[#584a3b] text-[#5c493c] dark:text-[#f3eadf]'
                      : 'text-[#9e8470] dark:text-[#b8ab9f] hover:bg-white/50 dark:hover:bg-[#292119]/50 hover:text-[#5c493c] dark:hover:text-[#f3eadf]'
                  }`}
                >
                  <span className={`text-[9px] font-black w-10 ${SIDEBAR_METHOD_COLORS[api.method] || 'text-gray-500'}`}>
                    {api.method}
                  </span>
                  <span className="truncate">{api.path}</span>
                </button>
              );
            })}
          </div>
        </div>
        
        {/* Right Content Pane */}
        <div className="flex-1 p-6 overflow-y-auto scrollbar-thin text-xs text-[#5c493c] dark:text-[#f3eadf]">
          {selectedItemId === 'schema' ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-[#3c2a1a] dark:text-[#f3eadf] flex items-center gap-2">
                  <span className="w-1.5 h-3 bg-[#ebdcb9] dark:bg-[#584a3b] rounded-full inline-block" />
                  α╣éα╕äα╕úα╕çα╕¬α╕úα╣ëα╕▓α╕çα╕éα╣ëα╕¡α╕íα╕╣α╕Ñ JSON α╕¬α╕│α╕½α╕úα╕▒α╕Üα╕Öα╕│α╣Çα╕éα╣ëα╕▓/α╕¬α╕│α╕úα╕¡α╕çα╕éα╣ëα╕¡α╕íα╕╣α╕Ñ (Import Template)
                </h3>
                <p className="text-[11px] text-[#7a6455] dark:text-[#f3eadf] leading-relaxed font-sans">
                  α╕äα╕╕α╕ôα╕¬α╕▓α╕íα╕▓α╕úα╕ûα╣üα╕üα╣ëα╣äα╕éα╕úα╕▓α╕óα╕üα╕▓α╕úα╕çα╕▓α╕Öα╣üα╕Üα╕Üα╕üα╕Ñα╕╕α╣êα╕í (Batch) α╣Çα╕₧α╕╖α╣êα╕¡α╕êα╕▒α╕öα╕üα╕▓α╕úα╣Çα╕¡α╕üα╕¬α╕▓α╕úα╕Ñα╣êα╕ºα╕çα╕½α╕Öα╣ëα╕▓ α╕Üα╕▒α╕Öα╕ùα╕╢α╕üα╣Çα╕¢α╣çα╕Öα╣äα╕ƒα╕Ñα╣î <code className="bg-[#f5eedf] dark:bg-[#1e1914] px-1.5 py-0.5 rounded border border-[#ebdcb9] dark:border-[#584a3b] font-mono text-[#aa7233] dark:text-[#f3eadf] text-[10px]">.json</code> α╣üα╕Ñα╣ëα╕ºα╕Öα╕│α╣Çα╕éα╣ëα╕▓α╕£α╣êα╕▓α╕Öα╕¢α╕╕α╣êα╕í <strong className="text-[#3c2a1a] dark:text-[#f3eadf]">Restore</strong> α╕öα╣ëα╕▓α╕Öα╕Üα╕Öα╣Çα╕₧α╕╖α╣êα╕¡α╣Çα╕èα╕╖α╣êα╕¡α╕íα╣éα╕óα╕çα╕üα╕▒α╕Ü API α╕ùα╕▒α╕Öα╕ùα╕╡
                </p>
              </div>

              <div className="space-y-1.5 bg-[#ffffff] dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl overflow-hidden shadow-2xs">
                <div className="bg-[#f5eedf]/60 dark:bg-[#1e1914]/60 px-4 py-2 border-b border-[#ebdcb9] dark:border-[#584a3b] flex justify-between items-center text-[10px]">
                  <span className="text-[#715c4d] dark:text-[#f3eadf] font-mono font-bold">template-backlog.json</span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleDownload}
                      className="hover:text-[#3a2010] dark:hover:text-[#f3eadf] bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] px-2.5 py-1 rounded-xl cursor-pointer text-[#715c4d] dark:text-[#f3eadf] font-semibold flex items-center gap-1 transition-all"
                    >
                      <Download size={11} /> Download Template
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCopy(jsonString, 'schema')}
                      className={`border px-2.5 py-1 rounded-xl cursor-pointer font-semibold flex items-center gap-1 transition-all ${
                        copied && copiedText === 'schema'
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                          : 'bg-white dark:bg-[#1e1914] border-[#ebdcb9] dark:border-[#584a3b] text-[#715c4d] dark:text-[#f3eadf] hover:text-[#3a2010] dark:hover:text-[#f3eadf]'
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
                
                <pre className="p-4 bg-[#fffdfa] dark:bg-[#1e1914] overflow-x-auto text-[11px] leading-relaxed text-[#a46c24] dark:text-[#f3eadf] font-mono scrollbar-thin max-h-64 font-semibold">
                  <code>{jsonString}</code>
                </pre>
              </div>

              <div className="border-t border-[#ebdcb9]/60 dark:border-[#584a3b]/60 pt-4 space-y-2 font-sans text-[11px] text-[#7a6455] dark:text-[#f3eadf] leading-relaxed">
                <p className="font-mono text-[9px] uppercase tracking-wider text-[#8a6e5a] dark:text-[#f3eadf] font-bold">α╕ƒα╕┤α╕Ñα╕öα╣îα╕ùα╕╡α╣êα╕¬α╕│α╕äα╕▒α╕ìα╕¢α╕úα╕░α╕üα╕¡α╕Üα╕öα╣ëα╕ºα╕ó:</p>
                <ul className="list-disc list-inside space-y-1 pl-1">
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">id</strong>: α╕äα╕╡α╕óα╣îα╕½α╕Ñα╕▒α╕üα╕úα╕░α╕Üα╕╕α╣üα╕òα╣êα╕Ñα╕░α╕çα╕▓α╕Ö α╕òα╣ëα╕¡α╕çα╣äα╕íα╣êα╕ïα╣ëα╕│α╕üα╕▒α╕Ö</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">projectId</strong>: α╕Üα╕▒α╕çα╕äα╕▒α╕Üα╣âα╕èα╣ë UUID α╕éα╕¡α╕çα╣éα╕¢α╕úα╣Çα╕êα╕üα╕òα╣î (Raw API α╕òα╣ëα╕¡α╕çα╕üα╕▓α╕úα╕ƒα╕┤α╕Ñα╕öα╣îα╕Öα╕╡α╣ë α╕¬α╣êα╕ºα╕Öα╕¥α╕▒α╣êα╕ç MCP α╕êα╕░α╕¡α╕Öα╕╕α╕íα╕▓α╕Öα╕êα╕▓α╕ü <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">repo</code> α╕½α╕úα╕╖α╕¡ <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">projectName</code> α╣äα╕öα╣ë)</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">status</strong>: α╕¬α╕ûα╕▓α╕Öα╕░α╕Üα╕¡α╕úα╣îα╕ö <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">"backlog" | "todo" | "in-progress" | "ready-for-review" | "done"</code></li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">priority</strong>: α╕úα╕░α╕öα╕▒α╕Üα╕äα╕ºα╕▓α╕íα╣Çα╕úα╣êα╕çα╕öα╣êα╕ºα╕Ö <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">"low" | "medium" | "high"</code></li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">targetFiles</strong>: α╕úα╕▓α╕óα╕èα╕╖α╣êα╕¡α╕₧α╕▓α╕ÿα╣äα╕ƒα╕Ñα╣îα╕ùα╕╡α╣êα╕úα╕░α╕Üα╕Üα╣Çα╕üα╕╡α╣êα╕óα╕ºα╕éα╣ëα╕¡α╕ç</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">checklist</strong>: α╕éα╕▒α╣ëα╕Öα╕òα╕¡α╕Öα╕üα╕▓α╕úα╕ùα╕│α╕çα╕▓α╕Öα╕ùα╕╡α╣êα╕òα╣ëα╕¡α╕çα╕ùα╕│ (executable work logic α╕äα╕ºα╕úα╕¡α╕óα╕╣α╣êα╣âα╕Öα╕Öα╕╡α╣ë α╣üα╕ùα╕Öα╕ùα╕╡α╣êα╕êα╕░α╕Üα╕¡α╕üα╕üα╕ºα╣ëα╕▓α╕çα╣å α╣âα╕Ö description)</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">agent</strong>: α╣Çα╕¡α╣Çα╕êα╕Öα╕òα╣îα╕ùα╕╡α╣êα╕úα╕▒α╕Üα╕£α╕┤α╕öα╕èα╕¡α╕Ü <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">"Codex" | "Antigravity" | "Claude"</code></li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">model</strong>: α╕èα╕╖α╣êα╕¡α╣éα╕íα╣Çα╕öα╕Ñ AI</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">effort</strong>: α╕úα╕░α╕öα╕▒α╕Üα╕₧α╕Ñα╕░α╕üα╕│α╕Ñα╕▒α╕ç (α╕òα╣ëα╕¡α╕çα╣âα╕èα╣ëα╕äα╣êα╕▓α╕òα╕▓α╕íα╕ùα╕╡α╣ê Agent/Model α╕¡α╕Öα╕╕α╕ìα╕▓α╕òα╣Çα╕ùα╣êα╕▓α╕Öα╕▒α╣ëα╕Ö) <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">"low" | "medium" | "high" | "xhigh"</code></li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">reasoning</strong>: α╣Çα╕½α╕òα╕╕α╕£α╕Ñ/α╕Üα╕úα╕┤α╕Üα╕ùα╕ùα╕╡α╣êα╕íα╕▓α╕éα╕¡α╕çα╕çα╕▓α╕Ö α╕üα╕úα╕ôα╕╡α╕úα╕ºα╕í FE/BE α╣Çα╕¢α╣çα╕Ö <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">fullstack</code> α╕òα╣ëα╕¡α╕çα╕úα╕░α╕Üα╕╕α╣Çα╕½α╕òα╕╕α╕£α╕Ñα╕ùα╕╡α╣êα╕Öα╕╡α╣êα╣Çα╕¬α╕íα╕¡</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">acceptanceCriteria</strong>: α╣Çα╕üα╕ôα╕æα╣îα╕üα╕▓α╕úα╕òα╕úα╕ºα╕êα╕úα╕▒α╕Üα╕çα╕▓α╕Ö (Acceptance Criteria)</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">verification</strong>: α╕éα╕▒α╣ëα╕Öα╕òα╕¡α╕Öα╕üα╕▓α╕úα╕òα╕úα╕ºα╕êα╕¬α╕¡α╕Üα╕½α╕úα╕╖α╕¡α╕ùα╕öα╕¬α╕¡α╕Üα╕ºα╣êα╕▓α╣Çα╕¬α╕úα╣çα╕êα╕¬α╕íα╕Üα╕╣α╕úα╕ôα╣î</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">repoContext</strong>: α╕éα╣ëα╕¡α╕äα╣ëα╕Öα╕₧α╕Üα╣Çα╕ëα╕₧α╕▓α╕░α╕çα╕▓α╕Ö, α╕¢α╕▒α╕ìα╕½α╕▓α╕½α╕úα╕╖α╕¡α╕éα╣ëα╕¡α╕êα╕│α╕üα╕▒α╕öα╕¢α╕▒α╕êα╕êα╕╕α╕Üα╕▒α╕Ö (α╕½α╣ëα╕▓α╕íα╣âα╕¬α╣ê URL, path, α╕½α╕úα╕╖α╕¡ branch α╕ïα╣ëα╕│α╕ïα╣ëα╕¡α╕Öα╕ùα╕╡α╣êα╕Öα╕╡α╣ê)</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">jiraKey</strong>: α╕úα╕½α╕▒α╕¬α╕Üα╕▒α╣èα╕ü/α╕çα╕▓α╕Öα╕Üα╕Ö Jira (α╣Çα╕èα╣êα╕Ö QCA-3314)</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">repo</strong>: α╕Ñα╕┤α╕çα╕üα╣îα╣äα╕¢α╕óα╕▒α╕ç Repository α╕ùα╕╡α╣êα╣Çα╕üα╕╡α╣êα╕óα╕ºα╕éα╣ëα╕¡α╕ç</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">sourceUrl</strong>: URL α╕¡α╣ëα╕▓α╕çα╕¡α╕┤α╕çα╕òα╣ëα╕Öα╕ùα╕▓α╕çα╕éα╕¡α╕çα╕òα╕▒α╣ïα╕ºα╕çα╕▓α╕Ö</li>
                </ul>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-[#3c2a1a] dark:text-[#f3eadf] flex items-center gap-2">
                  <span className="w-1.5 h-3 bg-[#ebdcb9] dark:bg-[#584a3b] rounded-full inline-block" />
                  α╕éα╣ëα╕¡α╕üα╕│α╕½α╕Öα╕öα╣üα╕Ñα╕░α╕úα╕▓α╕óα╕Ñα╕░α╣Çα╕¡α╕╡α╕óα╕ö Sandbox REST API (Active Specification)
                </h3>
                <p className="text-[11px] text-[#7a6455] dark:text-[#f3eadf] leading-relaxed font-sans">
                  α╣üα╕¡α╕¢α╕₧α╕Ñα╕┤α╣Çα╕äα╕èα╕▒α╕Öα╕ùα╕│α╕çα╕▓α╕Öα╣üα╕Üα╕Ü Sandbox Fullstack α╕úα╣êα╕ºα╕íα╕üα╕▒α╕Ü Node.js / Express Server α╕éα╕¡α╕çα╕½α╕Ñα╕▒α╕çα╕Üα╣ëα╕▓α╕Öα╕£α╣êα╕▓α╕Öα╕₧α╕¡α╕úα╣îα╕ò 3000 α╕öα╣ëα╕▓α╕Öα╕Ñα╣êα╕▓α╕çα╕Öα╕╡α╣ëα╕äα╕╖α╕¡ API Endpoints α╕ùα╕▒α╣ëα╕çα╕½α╕íα╕öα╕ùα╕╡α╣êα╕äα╕╕α╕ôα╕¬α╕▓α╕íα╕▓α╕úα╕ûα╕¬α╣êα╕ç HTTP Requests α╣äα╕¢α╣Çα╕èα╕╖α╣êα╕¡α╕íα╕òα╣êα╕¡α╕½α╕úα╕╖α╕¡α╕₧α╕¡α╕úα╣îα╕òα╕éα╣ëα╕¡α╕íα╕╣α╕Ñα╣äα╕öα╣ë
                </p>
              </div>

              <div className="space-y-4">
                {apiSpecsWithIds
                  .filter((api) => api.id === selectedItemId)
                  .map((api) => {
                  return (
                    <div key={api.id} className="bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl overflow-hidden shadow-3xs flex flex-col">
                      {/* Sub-header with Method & Path */}
                      <div className="bg-[#fcfaf5] dark:bg-[#1e1914] border-b border-[#ebdcb9] dark:border-[#584a3b] px-4 py-2.5 flex items-center justify-between font-mono">
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
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                              : 'bg-white dark:bg-[#1e1914] border-[#ebdcb9] dark:border-[#584a3b] text-[#7a6455] dark:text-[#f3eadf] hover:text-[#3c2a1a] dark:hover:text-[#f3eadf]'
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
                            <pre className="p-2.5 bg-[#fefdfb] dark:bg-[#1e1914] border border-[#e5d4bb]/70 dark:border-[#584a3b]/70 rounded-xl overflow-x-auto text-[10px] text-[#aa7233] dark:text-[#f3eadf] leading-relaxed max-h-36 scrollbar-thin">
                              <code>{api.payload}</code>
                            </pre>
                          </div>
                        )}

                        <div>
                          <p className="text-[#8c7463] dark:text-[#f3eadf] font-bold text-[9px] uppercase tracking-wider mb-0.5">Expected Response:</p>
                          <p className="text-[#554030] dark:text-[#f3eadf] bg-[#fffcf7] dark:bg-[#1e1914] px-2.5 py-1 rounded-lg border border-[#f5ecd4] dark:border-[#584a3b] font-semibold">{api.response}</p>
                        </div>

                        <div>
                          <p className="text-[#8c7463] dark:text-[#f3eadf] font-bold text-[9px] uppercase tracking-wider mb-1">Code Pattern Example (Fetch JS):</p>
                          <pre className="p-2.5 bg-[#1e293b] dark:bg-[#292119] text-[#38bdf8] dark:text-[#d6b56d] rounded-xl overflow-x-auto font-mono text-[10px] leading-relaxed">
                            <code>{api.example}</code>
                          </pre>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
