import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";

const DATA_FILE = path.join(process.cwd(), 'tasks.json');
const PROJECTS_FILE = path.join(process.cwd(), 'projects.json');

// Helpers
function loadJson(file: string, defaultVal: any) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.error(`Error reading ${file}:`, err);
  }
  return defaultVal;
}

function saveJson(file: string, data: any) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`Error writing ${file}:`, err);
  }
}

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
      }
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "list_projects") {
    const projects = loadJson(PROJECTS_FILE, []);
    return {
      content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
    };
  }

  if (name === "list_tasks") {
    const tasks = loadJson(DATA_FILE, []);
    const projectId = args?.projectId;
    const filtered = projectId ? tasks.filter((t: any) => t.projectId === projectId) : tasks;
    return {
      content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
    };
  }

  if (name === "create_task") {
    const tasks = loadJson(DATA_FILE, []);
    const newTask = {
      id: `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
      title: args?.title,
      description: args?.description || "",
      projectId: args?.projectId || "project-default",
      status: args?.status || "backlog",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      logs: [{
        id: `log-${Date.now()}-mcp`,
        timestamp: new Date().toISOString(),
        message: 'Task created via MCP Server.',
        type: 'create'
      }]
    };
    tasks.push(newTask);
    saveJson(DATA_FILE, tasks);
    return {
      content: [{ type: "text", text: JSON.stringify(newTask, null, 2) }],
    };
  }

  if (name === "move_task_status") {
    const tasks = loadJson(DATA_FILE, []);
    const { taskId, status } = args as any;
    const index = tasks.findIndex((t: any) => t.id === taskId);
    if (index === -1) {
      return {
        isError: true,
        content: [{ type: "text", text: `Task ${taskId} not found.` }],
      };
    }
    
    tasks[index].status = status;
    tasks[index].updatedAt = new Date().toISOString();
    tasks[index].logs.push({
        id: `log-${Date.now()}-mcp-move`,
        timestamp: new Date().toISOString(),
        message: `Status moved to ${status} via MCP Server.`,
        type: 'move'
    });
    
    saveJson(DATA_FILE, tasks);
    return {
      content: [{ type: "text", text: JSON.stringify(tasks[index], null, 2) }],
    };
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
