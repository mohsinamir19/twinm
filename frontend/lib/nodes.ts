export type ToolId = "memory" | "schedule" | "tasks" | "notes" | "notify" | "email";
export type NodeId = ToolId | "core";

export interface ToolNodeDef {
  id: ToolId;
  label: string;
  caption: string;
  /** App icon (transparent PNG, 512px) in /public. */
  icon: string;
  /** Whether the backend can drive this node today. */
  connected: boolean;
  /** Resting position in world units (core sits at the origin). */
  position: [number, number, number];
  /** Deterministic per-node seed for drift phase. */
  seed: number;
}

export const CORE_POSITION: [number, number, number] = [0, 0, 0];

/** Hexagon around the face: x/y on an ellipse (a=3.8, b=2.7). */
export const TOOLS: ToolNodeDef[] = [
  { id: "memory", label: "Memory", caption: "What I know about you", icon: "/icons/brain.png", connected: true, position: [0, 2.7, 0], seed: 1.3 },
  { id: "schedule", label: "Google Calendar", caption: "Events and reminders", icon: "/icons/google-calendar.png", connected: true, position: [3.8, 1.35, 0], seed: 2.7 },
  { id: "tasks", label: "Tasks", caption: "Checklist", icon: "/icons/tasks.png", connected: true, position: [3.8, -1.35, 0], seed: 4.1 },
  { id: "notify", label: "Pushover", caption: "Phone notifications", icon: "/icons/pushover.png", connected: true, position: [0, -2.7, 0], seed: 5.9 },
  { id: "notes", label: "Notion", caption: "Notes and write-ups", icon: "/icons/notion.png", connected: true, position: [-3.8, -1.35, 0], seed: 3.3 },
  { id: "email", label: "Gmail", caption: "Email", icon: "/icons/gmail.png", connected: true, position: [-3.8, 1.35, 0], seed: 6.7 },
];

export const COLORS = {
  cerulean: "#0EA5E9",
  mint: "#10B981",
  ink: "#0F172A",
} as const;

/** Backend tool name -> canvas node. */
export const TOOL_TO_NODE: Record<string, ToolId> = {
  add_event: "schedule",
  cancel_event: "schedule",
  get_day_summary: "schedule",
  add_task: "tasks",
  complete_task: "tasks",
  add_note: "notes",
  notify_owner: "notify",
  // Email tools are not in the backend yet; mapped so they light up the moment they exist.
  send_email: "email",
  read_email: "email",
  search_email: "email",
  draft_email: "email",
};

/** Mocked payloads shown in the click-to-inspect card. */
export const MOCK_PAYLOAD: Record<ToolId, unknown> = {
  memory: {
    tool: "memory.recall",
    query: "preferred meeting times",
    matches: [
      { fact: "Prefers mornings for deep work", confidence: 0.94 },
      { fact: "Timezone: Asia/Karachi", confidence: 0.99 },
    ],
  },
  schedule: {
    tool: "calendar.add_event",
    title: "Design review",
    start: "2026-11-12T15:00",
    duration_minutes: 30,
    online_meeting: true,
    status: "ok",
  },
  tasks: {
    tool: "tasks.add",
    title: "Send the project proposal",
    due: "2026-11-13",
    open_tasks: 4,
    status: "ok",
  },
  notify: { tool: "pushover.send", title: "Digital Twin", status: "ok" },
  email: { tool: "gmail", status: "not connected" },
  notes: {
    tool: "notes.add",
    text: "Ask about the launch checklist",
    pinned: true,
    total_notes: 7,
    status: "ok",
  },
};
