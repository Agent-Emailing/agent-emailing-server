// Tasks over email (Agent Emailing §10, Agent Messaging §7). Each party keeps
// its own task records. Updates can arrive out of order, so they are applied
// in the order of their envelopes' ts; an earlier update is recorded and
// changes nothing; a terminal task is never reopened; and a transition
// Agent Messaging §7.3 does not list is not applied.
import { Collection } from "./store.js";

export type TaskState = "submitted" | "working" | "input_required" | "auth_required" | "completed" | "failed" | "canceled" | "rejected" | "exhausted";

export const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "canceled", "rejected", "exhausted"]);

/** Agent Messaging §7.3. */
const ALLOWED: Record<string, string[]> = {
  submitted: ["working", "canceled", "exhausted", "rejected"],
  working: ["completed", "failed", "input_required", "auth_required", "canceled", "exhausted"],
  input_required: ["working", "canceled", "exhausted"],
  auth_required: ["working", "canceled", "exhausted"],
};

/** Whether `from` may move to `to`. Over email a performer often sends no
 *  `working` update, so a move that is allowed by way of `working` (such as
 *  submitted to completed) is accepted as that two-step move. */
export function canTransition(from: string | undefined, to: string): boolean {
  if (from === undefined) return true; // the first update a party sees opens its record
  if (from === to) return !TERMINAL.has(from);
  if (TERMINAL.has(from)) return false;
  if (ALLOWED[from]?.includes(to)) return true;
  return from !== "working" && Boolean(ALLOWED[from]?.includes("working")) && Boolean(ALLOWED.working!.includes(to));
}

export interface TaskRecord {
  task_id: string;
  context_id?: string;
  /** "requester" when this agent asked; "performer" when it does the work. */
  role: "requester" | "performer";
  peer: string;
  /** The peer's verified address, where answers go. */
  peerAddress?: string;
  offering?: string;
  offeringName?: string;
  /** The request that opened the task. */
  request_id?: string;
  state?: string;
  /** ts of the last update applied. */
  last_ts?: string;
  /** Email threading: the Message-IDs so far, oldest first. */
  messageIds: string[];
  history: { id: string; ts: string; state: string; applied: boolean; why?: string }[];
}

export class TaskStore {
  private tasks: Collection<TaskRecord>;
  constructor(dir?: string) { this.tasks = new Collection(dir, "tasks"); }
  get(id: string): TaskRecord | undefined { return this.tasks.get(id); }
  all(): TaskRecord[] { return this.tasks.values(); }
  put(t: TaskRecord): void { this.tasks.set(t.task_id, t); }

  /** Apply one update. Returns whether it changed the task's state. */
  apply(taskId: string, update: { id: string; ts: string; state: string }, init: Omit<TaskRecord, "task_id" | "history" | "messageIds"> & { messageIds?: string[] }): { applied: boolean; why?: string; record: TaskRecord } {
    const t: TaskRecord = this.tasks.get(taskId) ?? { ...init, task_id: taskId, messageIds: init.messageIds ?? [], history: [] };
    let applied = false, why: string | undefined;
    if (t.history.some((h) => h.id === update.id)) why = "already recorded";
    else if (t.last_ts && Date.parse(update.ts) < Date.parse(t.last_ts)) why = "earlier than the last update applied";
    else if (t.state && TERMINAL.has(t.state)) why = `the task is already ${t.state}`;
    else if (!canTransition(t.state, update.state)) why = `${t.state} to ${update.state} is not a transition Agent Messaging §7.3 allows`;
    else { t.state = update.state; t.last_ts = update.ts; applied = true; }
    if (why !== "already recorded") t.history.push({ ...update, applied, ...(why ? { why } : {}) });
    this.put(t);
    return { applied, why, record: t };
  }
}
