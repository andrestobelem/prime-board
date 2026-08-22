export const DEFAULT_WORKSPACE_NAME = "workspace";
export const DEFAULT_WORKSPACE_URL_KEY = "prime-board";
export const DEFAULT_TEAM_NAME = "Prime Board";
export const DEFAULT_TEAM_KEY = "PB";

// Workflow default que se siembra al crear un team (spec §3, tabla workflow_states).
export const DEFAULT_WORKFLOW = [
  { name: "Backlog", type: "backlog", color: "#95a2b3" },
  { name: "Todo", type: "unstarted", color: "#e2e2e2" },
  { name: "In Progress", type: "started", color: "#f2c94c" },
  { name: "Done", type: "completed", color: "#5e6ad2" },
  { name: "Canceled", type: "canceled", color: "#95a2b3" },
] as const;
