---
title: Getting Started
description: Build your first mini-app step by step.
---

This guide walks through creating a mini-app, from the basic setup to adding persistence and a backend.

## Prerequisites

Mini-apps are created by Agents using AI tools. You interact with them through conversation:

> "Create a todo list mini-app"

The Agent calls `create_mini_app` and the app appears in your sidebar. But understanding the internals helps you guide the Agent effectively.

## The Minimal App

Every mini-app needs:

1. **An `app.json`** declaring React dependencies
2. **An `index.html`** with a root div and JSX script

### app.json

```json
{
  "dependencies": {
    "react": "https://esm.sh/react@19",
    "react-dom/client": "https://esm.sh/react-dom@19/client",
    "@hivekeep/react": "/api/mini-apps/sdk/hivekeep-react.js"
  }
}
```

Add the component library (optional but recommended):

```json
{
  "dependencies": {
    "react": "https://esm.sh/react@19",
    "react-dom/client": "https://esm.sh/react-dom@19/client",
    "@hivekeep/react": "/api/mini-apps/sdk/hivekeep-react.js",
    "@hivekeep/components": "/api/mini-apps/sdk/hivekeep-components.js"
  }
}
```

### index.html

```html
<div id="root"></div>
<script type="text/jsx">
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useHivekeep } from "@hivekeep/react";

function App() {
  const { ready } = useHivekeep();
  if (!ready) return <div>Loading...</div>;
  return <h1>Hello, Mini-App!</h1>;
}

createRoot(document.getElementById("root")).render(<App />);
</script>
```

**Important:** Always call `useHivekeep()` at the root of your app and wait for `ready` before rendering content. The hook calls `Hivekeep.ready()` internally and sets `ready` to `true` once the SDK bridge is initialized.

## Using Templates

Instead of writing HTML from scratch, Agents can use built-in templates:

```
"Create a dashboard mini-app using the dashboard template"
```

Available templates: `dashboard`, `todo-list`, `form`, `data-viewer`, `kanban`, `responsive`, `background-service` (a live backend with scheduled jobs and notifications).

Use `get_mini_app_templates` to see all templates with descriptions.

## Adding Persistence

Use `useStorage` to persist data across sessions:

```jsx
import { useHivekeep, useStorage } from "@hivekeep/react";

function TodoApp() {
  const { ready } = useHivekeep();
  const [todos, setTodos, loading] = useStorage("todos", []);

  if (!ready || loading) return <div>Loading...</div>;

  const addTodo = (text) => {
    setTodos(prev => [...prev, { id: Date.now(), text, done: false }]);
  };

  // ... render todos
}
```

`useStorage` works like `useState` but persists to Hivekeep's key-value storage. It returns `[value, setValue, loading]`. The `loading` flag is `true` while fetching the initial value. `setValue` accepts either a direct value or an updater function (like React's `useState`).

## Adding a Backend

For server-side logic, create a `_server.js` file:

```javascript
export default function(ctx) {
  const app = new ctx.Hono();

  app.get("/stats", async (c) => {
    const keys = await ctx.storage.list();
    return c.json({ totalKeys: keys.length });
  });

  return app;
}
```

Access it from the frontend:

```jsx
import { useApi } from "@hivekeep/react";

function Stats() {
  const { data, loading } = useApi("/stats");
  if (loading) return <Spinner />;
  return <p>Total keys: {data.totalKeys}</p>;
}
```

See [Backend](/docs/mini-apps/backend/) for the full backend guide.

## Multi-File Apps

Mini-apps can have multiple files. Use `write_mini_app_file` to add CSS, JavaScript, images, or additional JSX files:

```
app-files/
├── index.html        # Entry point
├── app.json          # Dependencies
├── _server.js        # Backend (optional)
├── styles.css        # Custom styles
├── components/
│   └── header.jsx    # Additional components
└── img/
    └── logo.png      # Static assets
```

Reference files with relative paths in your HTML:

```html
<link rel="stylesheet" href="styles.css">
<script type="text/jsx" src="components/header.jsx"></script>
```

## Snapshots and Rollback

Before making risky changes, create a snapshot:

```
"Create a snapshot of the todo app before the redesign"
```

The Agent calls `create_mini_app_snapshot`. If something breaks, roll back:

```
"Roll back the todo app to the previous version"
```

Max 20 snapshots per app (oldest are auto-pruned).

## Next Steps

- [Components](/docs/mini-apps/components/) — Browse 50+ themed components
- [Hooks](/docs/mini-apps/hooks/) — All available React hooks
- [SDK Reference](/docs/mini-apps/sdk-reference/) — Complete API
- [Guidelines](/docs/mini-apps/guidelines/) — Best practices
