import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE_URL = 'http://localhost:3000/api';

// Create server
const server = new Server(
  {
    name: "dev-flow-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_projects",
        description: "Get a list of all projects",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_tasks",
        description: "Get a list of all tasks",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string", description: "Optional project ID to filter tasks" }
          },
        },
      },
      {
        name: "create_task",
        description: "Create a new task",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Task title" },
            description: { type: "string", description: "Task description" },
            projectId: { type: "string", description: "Project ID (defaults to project-default)" },
            status: { type: "string", description: "Task status: backlog, todo, in-progress, ready-for-review, done" },
          },
          required: ["title"],
        },
      },
      {
        name: "move_task_status",
        description: "Move a task to a different status",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "The ID of the task to update" },
            status: { type: "string", description: "The new status (backlog, todo, in-progress, ready-for-review, done)" },
          },
          required: ["taskId", "status"],
        },
      },
      {
        name: "list_skills",
        description: "List all available agent skills in DevFlow",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_skill",
        description: "Get the content of a specific skill",
        inputSchema: {
          type: "object",
          properties: {
            skillId: { type: "string", description: "The ID of the skill to fetch" }
          },
          required: ["skillId"],
        },
      },
      {
        name: "update_skill",
        description: "Update the content of a specific skill",
        inputSchema: {
          type: "object",
          properties: {
            skillId: { type: "string", description: "The ID of the skill to update" },
            content: { type: "string", description: "The new markdown content of the skill" }
          },
          required: ["skillId", "content"],
        },
      }
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "list_projects") {
    try {
      const response = await fetch(`${API_BASE_URL}/projects`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const projects = await response.json();
      return {
        content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
      };
    } catch (err: any) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
  }

  if (name === "list_tasks") {
    try {
      const response = await fetch(`${API_BASE_URL}/tasks`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const tasks = await response.json();
      const projectId = args?.projectId;
      const filtered = projectId ? tasks.filter((t: any) => t.projectId === projectId) : tasks;
      return {
        content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
      };
    } catch (err: any) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
  }

  if (name === "create_task") {
    try {
      // Need repoUrl or similar to avoid error if server requires it, but let's just pass what the schema specifies.
      // Wait, server needs 'repo' or it resolves to a project if projectId is found. 
      // Assuming projectId 'project-default' works.
      const response = await fetch(`${API_BASE_URL}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: args?.title,
          description: args?.description || "",
          projectId: args?.projectId || "project-default",
          status: args?.status || "backlog",
          repo: "mcp-proxy-created" // provide a dummy repo to satisfy any server-side validation if needed
        })
      });
      if (!response.ok) {
         const errorData = await response.json().catch(() => ({}));
         throw new Error(errorData.error || `HTTP ${response.status}`);
      }
      const newTask = await response.json();
      return {
        content: [{ type: "text", text: JSON.stringify(newTask, null, 2) }],
      };
    } catch (err: any) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
  }

  if (name === "move_task_status") {
    const { taskId, status } = args as any;
    try {
      const response = await fetch(`${API_BASE_URL}/tasks/${taskId}/move`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Agent-Request': 'true'
        },
        body: JSON.stringify({ status })
      });
      if (!response.ok) {
         const errorData = await response.json().catch(() => ({}));
         throw new Error(errorData.error || `HTTP ${response.status}`);
      }
      const data = await response.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data.task || data, null, 2) }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: err.message }],
      };
    }
  }

  if (name === "list_skills") {
    try {
      const response = await fetch(`${API_BASE_URL}/skills`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const skills = await response.json();
      return {
        content: [{ type: "text", text: JSON.stringify(skills, null, 2) }],
      };
    } catch (err: any) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
  }

  if (name === "get_skill") {
    const { skillId } = args as any;
    try {
      const response = await fetch(`${API_BASE_URL}/skills/${skillId}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const skill = await response.json();
      return {
        content: [{ type: "text", text: JSON.stringify(skill, null, 2) }],
      };
    } catch (err: any) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
  }

  if (name === "update_skill") {
    const { skillId, content } = args as any;
    try {
      const response = await fetch(`${API_BASE_URL}/skills/${skillId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      if (!response.ok) {
         const errorData = await response.json().catch(() => ({}));
         throw new Error(errorData.error || `HTTP ${response.status}`);
      }
      const data = await response.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (err: any) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// Run server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("DevFlow MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
