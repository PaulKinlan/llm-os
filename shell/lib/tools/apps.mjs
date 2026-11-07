// App tools: the model writes small HTML apps, the shell runs them sandboxed,
// and both sides can call each other's tools (Web MCP style).
import * as store from "../store.mjs";
import { emit, request } from "../events.mjs";

const obj = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export const APP_GUIDE = `Mini apps are single self-contained HTML documents (inline CSS and JS; no build step).
They run in a sandboxed iframe with an opaque origin: no cookies, no localStorage persistence, no top navigation, no alert().
Network: fetch() to https URLs works when the remote server allows CORS. Images from https and data: URLs work.
The shell injects two globals before your code runs:
  window.webMcp.registerTool({ name, description, parameters /* JSON schema */, execute: async (args) => result })
     – expose an action the assistant can call with call_app_tool. Call window.webMcp.ready() after registering.
  window.os.call(toolName, args) -> Promise<result>
     – call a system tool (e.g. "wifi_scan", "set_volume"). Only tools listed in the app's permissions work;
       "confirm"-tier tools still ask the user. Use this to build settings panels for real hardware.
  window.os.storage.get(key) / .set(key, value) -> Promise – small per-app persistent storage kept by the shell.
Design: fill the viewport (html,body{height:100%;margin:0}), respect prefers-color-scheme, use system-ui fonts,
large touch targets, and no external frameworks unless clearly needed (then load from cdnjs.cloudflare.com).`;

export const appTools = [
  {
    name: "create_app",
    tier: "change",
    description:
      "Create (or fully replace) a mini app and open it on the app stage next to the conversation. " +
      "Use this whenever a visual, interactive or persistent UI would serve the user better than text. " +
      "See the app guide in the system prompt.",
    eager: true,
    input_schema: obj(
      {
        name: { type: "string", description: "Short name; becomes the slug, e.g. \"wifi\" or \"pomodoro\"" },
        title: { type: "string", description: "Title shown on the app tab" },
        description: { type: "string", description: "One line on what it does" },
        permissions: { type: "array", items: { type: "string" }, description: "System tool names the app may call via os.call" },
        html: { type: "string", description: "The complete HTML document" },
      },
      ["name", "title", "html"],
    ),
    async run(input, ctx) {
      const slug = store.slugify(input.name);
      const meta = await store.saveApp({ slug, title: input.title, description: input.description, permissions: input.permissions || [], html: input.html, projectId: ctx.projectId });
      emit("app_open", { slug, version: meta.version, title: meta.title });
      emit("apps_changed");
      return { ok: true, slug, version: meta.version, note: "App saved and opened. If it registers tools, call list_app_tools to see them." };
    },
  },
  {
    name: "edit_app",
    tier: "change",
    description: "Change part of an existing app's HTML by exact search-and-replace, then reload it. Prefer this over create_app for small changes.",
    eager: true,
    input_schema: obj(
      {
        slug: { type: "string" },
        old_str: { type: "string", description: "Exact text currently in the app, must occur once" },
        new_str: { type: "string", description: "Replacement text" },
      },
      ["slug", "old_str", "new_str"],
    ),
    async run({ slug, old_str, new_str }) {
      const app = await store.getApp(slug);
      if (!app) return { error: `no app "${slug}"` };
      const count = app.html.split(old_str).length - 1;
      if (count !== 1) return { error: `old_str must occur exactly once (found ${count})` };
      const meta = await store.saveApp({ slug, html: app.html.replace(old_str, () => new_str) });
      emit("app_open", { slug, version: meta.version, title: meta.title });
      return { ok: true, slug, version: meta.version };
    },
  },
  {
    name: "read_app",
    tier: "read",
    description: "Read an app's metadata and full HTML source.",
    input_schema: obj({ slug: { type: "string" } }, ["slug"]),
    async run({ slug }) {
      return (await store.getApp(slug)) || { error: `no app "${slug}"` };
    },
  },
  {
    name: "list_apps",
    tier: "read",
    description: "List installed mini apps (slug, title, description, permissions) and which are open right now.",
    input_schema: obj(),
    async run() {
      const apps = await store.listApps();
      let open = [];
      try {
        open = await request("ui_query", { what: "open_apps" }, { timeoutMs: 3000 });
      } catch {}
      return apps.map(({ slug, title, description, permissions, version }) => ({ slug, title, description, permissions, version, open: open.includes(slug) }));
    },
  },
  {
    name: "open_app",
    tier: "change",
    description: "Open an installed app on the app stage (or bring it to the front).",
    input_schema: obj({ slug: { type: "string" } }, ["slug"]),
    async run({ slug }) {
      const app = await store.getApp(slug);
      if (!app) return { error: `no app "${slug}"` };
      emit("app_open", { slug, version: app.version, title: app.title });
      return { ok: true };
    },
  },
  {
    name: "close_app",
    tier: "change",
    description: "Close an open app (it stays installed).",
    input_schema: obj({ slug: { type: "string" } }, ["slug"]),
    async run({ slug }) {
      emit("app_close", { slug });
      return { ok: true };
    },
  },
  {
    name: "delete_app",
    tier: "confirm",
    description: "Uninstall an app and delete its files.",
    input_schema: obj({ slug: { type: "string" } }, ["slug"]),
    summarize: (i) => `Delete the app "${i.slug}"`,
    async run({ slug }) {
      emit("app_close", { slug });
      await store.deleteApp(slug);
      emit("apps_changed");
      return { ok: true };
    },
  },
  {
    name: "list_app_tools",
    tier: "read",
    description: "List the tools an open app registered with webMcp.registerTool.",
    input_schema: obj({ slug: { type: "string" } }, ["slug"]),
    async run({ slug }) {
      return request("app_list_tools", { slug }, { timeoutMs: 5000 });
    },
  },
  {
    name: "call_app_tool",
    tier: "change",
    description: "Call a tool that an open app registered (see list_app_tools). The app is opened first if needed.",
    input_schema: obj({ slug: { type: "string" }, tool: { type: "string" }, args: { type: "object", description: "Arguments for the app tool" } }, ["slug", "tool"]),
    async run({ slug, tool, args = {} }) {
      return request("app_call_tool", { slug, tool, args }, { timeoutMs: 15000 });
    },
  },
];
