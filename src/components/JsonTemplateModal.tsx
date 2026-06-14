/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, Copy, Check, Download, FileCode, Terminal, HelpCircle, Activity, Globe, ShieldAlert } from 'lucide-react';
import { getAgentCatalogHelp, getValidAgentModelEffortExamples, getInvalidAgentModelEffortExamples } from '../lib/agentsConfig';

interface JsonTemplateModalProps {
  onClose: () => void;
}

export default function JsonTemplateModal({ onClose }: JsonTemplateModalProps) {
  const [activeTab, setActiveTab] = useState<'schema' | 'api'>('schema');
  const [copied, setCopied] = useState(false);
  const [copiedText, setCopiedText] = useState('');

  const sampleJson = [
    {
      "id": "spec-101",
      "projectId": "YOUR_PROJECT_ID",
      "parentId": "optional-parent-id",
      "title": "Setup Authentication API with Bearer Tokens",
      "description": "### Objective\nSecure all backend routes with JWT keys.\n\n### Requirements\n- Verify passwords using Argon2\n- Configure access-token expires boundary in 15m",
      "status": "todo",
      "priority": "high",
      "tags": ["backend", "api", "security"],
      "branch": "feature/api-auth",
      "targetFiles": [
        "src/controllers/authController.ts",
        "src/middlewares/authMiddleware.ts"
      ],
      "checklist": [
        {
          "id": "step-1",
          "text": "Add token validation tests in Jest",
          "completed": false
        },
        {
          "id": "step-2",
          "text": "Test custom header check against empty Authorization keys",
          "completed": false
        }
      ],
      "agent": "Codex",
      "model": "GPT-5.4",
      "effort": "medium",
      "reasoning": "We need to ensure API endpoints are secure from unauthorized access.",
      "acceptanceCriteria": "All API endpoints return 401 when missing valid JWT.",
      "verification": "Run `npm run test:auth` and ensure 100% coverage on new middleware.",
      "repoContext": "This relies on the `argon2` module implemented last week.",
      "jiraKey": "QCA-3314",
      "repo": "https://github.com/my-org/auth-service",
      "sourceUrl": "https://jira.my-org.com/browse/QCA-3314",
      "createdAt": "2026-06-08T05:00:00.000Z",
      "updatedAt": "2026-06-08T05:05:00.000Z",
      "logs": [
        {
          "id": "log-1",
          "timestamp": "2026-06-08T05:00:00.000Z",
          "message": "Initialized secure auth route specifications",
          "type": "create"
        }
      ]
    }
  ];

  const jsonString = JSON.stringify(sampleJson, null, 2);

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
      description: 'สร้างหรือบันทึกการ์ดงานแบบกลุ่ม/เดี่ยว (Create or Bulk Upsert) รองรับการส่งในรูป { repo: "...", tasks: [] } เพื่อให้ระบุ repo ไว้ทีเดียวที่เลเยอร์นอกสุด สะดวกขึ้นมาก',
      payload: '{\n  "repo": "URL ของ Repository (Required: ส่วนหัวหรือข้างในก็ได)",\n  "tasks": [\n    {\n      "title": "ชื่องานใหม่",\n      "description": "คำอธิบาย Markdown"\n    }\n  ]\n}\n\nหรือส่งรูปดั้งเดิม (Task ตัวเดี่ยวๆ หรือ JSON Array แบบระบุ repo แยกชิ้น)',
      response: 'JSON Object ของ Task เดียวที่สร้างสมบูรณ์ หรือ JSON Object แสดงสถิติจำนวน { success: true, createdCount: number, updatedCount: number, tasks: Array } เมื่อใช้รูปแบบอาร์เรย์หรือห่อหุ้ม',
      example: 'fetch(\'/api/tasks\', {\n  method: \'POST\',\n  headers: { \'Content-Type\': \'application/json\' },\n  body: JSON.stringify({\n    repo: \'https://github.com/google/ai-studio\',\n    tasks: [\n      { title: \'Task 1 under outer repo\' },\n      { title: \'Task 2 under outer repo\' }\n    ]\n  })\n}).then(res => res.json());'
    },
    {
      method: 'POST',
      path: '/api/tasks/batch',
      description: 'เขียนและอัปเดตบันทึกการ์ดงานพร้อมกันแบบกลุ่ม (Batch List Update/Upsert) รองรับการอัปเดตแบบผสมทั้งสร้างใหม่และแก้ของเดิม',
      payload: '{\n  "repo": "URL สำหรับผูกกรณีใบสร้างใหม่ (Optional)",\n  "tasks": [\n    {\n      "id": "task-old (ใส่กรณีต้องการแก้ใบเดิม)",\n      "title": "ชื่องานอัปเดต"\n    }\n  ]\n}',
      response: 'JSON Object ยืนยันสถานะการอัปเดตแบบกลุ่ม { success: true, createdCount: number, updatedCount: number, tasks: Array }',
      example: 'fetch(\'/api/tasks/batch\', {\n  method: \'POST\',\n  headers: { \'Content-Type\': \'application/json\' },\n  body: JSON.stringify({\n    repo: \'https://github.com/google/ai-studio\',\n    tasks: [\n      { title: \'Task 1 via outer POST batch\' },\n      { id: \'task-1\', status: \'done\' }\n    ]\n  })\n}).then(res => res.json());'
    },
    {
      method: 'PUT',
      path: '/api/tasks',
      description: 'เขียนและอัปเดตบันทึกการ์ดงานพร้อมกันแบบกลุ่ม (Batch List Update/Upsert) - พฤติกรรมเหมือน /api/tasks/batch',
      payload: '{\n  "repo": "URL สำหรับผูกกรณีใบสร้างใหม่ (Optional)",\n  "tasks": [\n    {\n      "id": "task-old (ใส่กรณีต้องการแก้ใบเดิม)",\n      "title": "ชื่องานอัปเดต"\n    }\n  ]\n}',
      response: 'JSON Object ยืนยันสถานะการอัปเดตแบบกลุ่ม { success: true, createdCount: number, updatedCount: number, tasks: Array }',
      example: 'fetch(\'/api/tasks\', {\n  method: \'PUT\',\n  headers: { \'Content-Type\': \'application/json\' },\n  body: JSON.stringify({\n    repo: \'https://github.com/google/ai-studio\',\n    tasks: [\n      { title: \'Task 1 via outer PUT\' },\n      { id: \'task-1\', status: \'done\' }\n    ]\n  })\n}).then(res => res.json());'
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

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in select-text">
      {/* Click outside to close */}
      <div className="fixed inset-0" onClick={onClose} />

      <div className="bg-[#fcfaf5] dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] w-full max-w-2xl rounded-3xl shadow-2xl relative z-10 overflow-hidden flex flex-col justify-between font-sans max-h-[85vh]">
        
        {/* Header toolbar */}
        <div className="p-5 border-b border-[#ebdcb9] dark:border-[#584a3b] bg-[#ebdcb9]/40 dark:bg-[#584a3b]/40 flex items-center justify-between font-mono text-[#5c493c] dark:text-[#f3eadf]">
          <div className="flex items-center gap-2">
            <FileCode size={18} className="text-[#bf8a50] dark:text-[#d6b56d]" />
            <h2 className="text-xs font-black text-[#5c493c] dark:text-[#f3eadf] tracking-tight uppercase">
              Developer Documentation Hub
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 dark:text-[#b8ab9f] hover:text-red-500 p-1.5 rounded-full hover:bg-white dark:hover:bg-[#292119]/60 transition-all cursor-pointer"
          >
            <X size={17} />
          </button>
        </div>

        {/* Tab Buttons bar */}
        <div className="bg-[#f5eedf]/60 dark:bg-[#1e1914]/60 border-b border-[#ebdcb9] dark:border-[#584a3b] px-4 pt-2 flex items-center gap-2">
          <button
            onClick={() => setActiveTab('schema')}
            className={`px-4 py-2 text-xs font-extrabold font-mono border-t border-x rounded-t-xl transition-all cursor-pointer ${
              activeTab === 'schema'
                ? 'bg-[#fcfaf5] dark:bg-[#1e1914] border-[#ebdcb9] dark:border-[#584a3b] text-[#784d21] dark:text-[#f3eadf] -mb-[1px]'
                : 'bg-transparent dark:bg-transparent border-transparent dark:border-transparent text-[#9e8470] dark:text-[#d6b56d] hover:text-[#5c493c] dark:text-[#f3eadf] dark:hover:text-[#f3eadf]'
            }`}
          >
            📄 JSON Schema Spec
          </button>
          <button
            onClick={() => setActiveTab('api')}
            className={`px-4 py-2 text-xs font-extrabold font-mono border-t border-x rounded-t-xl transition-all cursor-pointer ${
              activeTab === 'api'
                ? 'bg-[#fcfaf5] dark:bg-[#1e1914] border-[#ebdcb9] dark:border-[#584a3b] text-[#784d21] dark:text-[#f3eadf] -mb-[1px]'
                : 'bg-transparent dark:bg-transparent border-transparent dark:border-transparent text-[#9e8470] dark:text-[#d6b56d] hover:text-[#5c493c] dark:text-[#f3eadf] dark:hover:text-[#f3eadf]'
            }`}
          >
            🌐 REST API Spec
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto scrollbar-thin text-xs text-[#5c493c] dark:text-[#f3eadf] flex-1">
          {activeTab === 'schema' ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-[#3c2a1a] dark:text-[#f3eadf] flex items-center gap-2">
                  <span className="w-1.5 h-3 bg-[#ebdcb9] dark:bg-[#584a3b] rounded-full inline-block" />
                  โครงสร้างข้อมูล JSON สำหรับนำเข้า/สำรองข้อมูล (Import Template)
                </h3>
                <p className="text-[11px] text-[#7a6455] dark:text-[#f3eadf] leading-relaxed font-sans">
                  คุณสามารถแก้ไขรายการงานแบบกลุ่ม (Batch) เพื่อจัดการเอกสารล่วงหน้า บันทึกเป็นไฟล์ <code className="bg-[#f5eedf] dark:bg-[#1e1914] px-1.5 py-0.5 rounded border border-[#ebdcb9] dark:border-[#584a3b] font-mono text-[#aa7233] dark:text-[#f3eadf] text-[10px]">.json</code> แล้วนำเข้าผ่านปุ่ม <strong className="text-[#3c2a1a] dark:text-[#f3eadf]">Restore</strong> ด้านบนเพื่อเชื่อมโยงกับ API ทันที
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
                          : 'bg-white dark:bg-[#1e1914] border-[#ebdcb9] dark:border-[#584a3b] text-[#715c4d] dark:text-[#f3eadf] hover:text-[#3a2010] dark:text-[#f3eadf] dark:hover:text-[#f3eadf]'
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
                <p className="font-mono text-[9px] uppercase tracking-wider text-[#8a6e5a] dark:text-[#f3eadf] font-bold">ฟิลด์ที่สำคัญประกอบด้วย:</p>
                <ul className="list-disc list-inside space-y-1 pl-1">
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">id</strong>: คีย์หลักระบุแต่ละงาน ต้องไม่ซ้ำกัน</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">repo</strong>: บังคับเชื่อมโยง URL ของ Repository เช่น <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">"https://github.com/user/repo"</code> (*Required* สำหรับการสร้างใหม่)</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">status</strong>: สถานะบอร์ด <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">"backlog" | "todo" | "in-progress" | "ready-for-review" | "done"</code></li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">priority</strong>: ระดับความเร่งด่วน <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">"low" | "medium" | "high"</code></li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">targetFiles</strong>: รายชื่อพาธไฟล์ที่ระบบเกี่ยวข้อง</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">checklist</strong>: โครงสร้าง Mini-Tasks ย่อยภายในแต่ละตั๋ว</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">agent</strong>: เอเจนต์ที่รับผิดชอบ <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">"Codex" | "Antigravity" | "Claude"</code></li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">model</strong>: ชื่อตัวแปรโมเดล AI Spec เช่น คู่ขนานตามโมเดลที่เลือก</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">effort</strong>: ระดับพละกำลังความเพียรประมวลผล ขึ้นอยู่กับ Agent/Model <code className="font-mono bg-[#f5eedf] dark:bg-[#1e1914] px-1 text-[10px]">เช่น Codex+GPT-5.4 ใช้ xhigh ได้</code></li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">reasoning</strong>: เหตุผลหรือบริบทที่มาของงาน</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">acceptanceCriteria</strong>: เกณฑ์การตรวจรับงาน (Acceptance Criteria)</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">verification</strong>: ขั้นตอนการตรวจสอบหรือทดสอบว่าเสร็จสมบูรณ์</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">repoContext</strong>: บริบทเพิ่มเติมเกี่ยวกับ Repository ที่ใช้</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">jiraKey</strong>: รหัสบั๊ก/งานบน Jira (เช่น QCA-3314)</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">repo</strong>: ลิงก์ไปยัง Repository ที่เกี่ยวข้อง</li>
                  <li><strong className="font-mono text-[10.5px] text-[#3c2a1a] dark:text-[#f3eadf]">sourceUrl</strong>: URL อ้างอิงต้นทางของตั๋วงาน</li>
                </ul>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-[#3c2a1a] dark:text-[#f3eadf] flex items-center gap-2">
                  <span className="w-1.5 h-3 bg-[#ebdcb9] dark:bg-[#584a3b] rounded-full inline-block" />
                  ข้อกำหนดและรายละเอียด Sandbox REST API (Active Specification)
                </h3>
                <p className="text-[11px] text-[#7a6455] dark:text-[#f3eadf] leading-relaxed font-sans">
                  แอปพลิเคชันทำงานแบบ Sandbox Fullstack ร่วมกับ Node.js / Express Server ของหลังบ้านผ่านพอร์ต 3000 ด้านล่างนี้คือ API Endpoints ทั้งหมดที่คุณสามารถส่ง HTTP Requests ไปเชื่อมต่อหรือพอร์ตข้อมูลได้
                </p>
              </div>

              <div className="space-y-4">
                {apiSpecs.map((api, idx) => {
                  const methodColors: Record<string, string> = {
                    GET: 'bg-emerald-50 text-emerald-700 border-emerald-200',
                    POST: 'bg-blue-50 text-blue-700 border-blue-200',
                    PUT: 'bg-amber-50 text-amber-700 border-amber-200',
                    DELETE: 'bg-rose-50 text-rose-700 border-rose-200',
                  };

                  return (
                    <div key={idx} className="bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl overflow-hidden shadow-3xs flex flex-col">
                      {/* Sub-header with Method & Path */}
                      <div className="bg-[#fcfaf5] dark:bg-[#1e1914] border-b border-[#ebdcb9] dark:border-[#584a3b] px-4 py-2.5 flex items-center justify-between font-mono">
                        <div className="flex items-center gap-2.5">
                          <span className={`px-2 py-0.5 rounded-lg border text-[9.5px] font-black tracking-wide ${methodColors[api.method] || 'bg-gray-100 dark:bg-[#1e1914]'}`}>
                            {api.method}
                          </span>
                          <span className="text-[11.5px] font-bold text-[#3c2a1a] dark:text-[#f3eadf]">{api.path}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleCopy(api.example, `example-${idx}`)}
                          className={`text-[9.5px] border px-2 py-0.5 rounded-lg font-bold cursor-pointer transition-colors ${
                            copied && copiedText === `example-${idx}`
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                              : 'bg-white dark:bg-[#1e1914] border-[#ebdcb9] dark:border-[#584a3b] text-[#7a6455] dark:text-[#f3eadf] hover:text-[#3c2a1a] dark:hover:text-[#f3eadf]'
                          }`}
                        >
                          {copied && copiedText === `example-${idx}` ? 'Copied script!' : 'Copy Code'}
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
                          <pre className="p-2.5 bg-[#1e293b] dark:bg-[#d6b56d] dark:bg-[#e0a070] text-[#38bdf8] dark:text-[#d6b56d] rounded-xl overflow-x-auto font-mono text-[10px] leading-relaxed">
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

        {/* Footer */}
        <div className="p-4 bg-[#ebdcb9]/40 dark:bg-[#584a3b]/40 border-t border-[#ebdcb9] dark:border-[#584a3b] flex justify-end text-xs font-mono">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] text-[#6d5a4d] dark:text-[#f3eadf] hover:bg-[#fffcf6] dark:bg-[#1e1914] dark:hover:bg-[#1e1914] rounded-xl font-bold font-mono transition-colors cursor-pointer shadow-3xs"
          >
            ปิดหน้าเอกสาร
          </button>
        </div>
      </div>
    </div>
  );
}
