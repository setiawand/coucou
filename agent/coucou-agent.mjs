#!/usr/bin/env node
// coucou-agent — runs ONE task with the Claude Agent SDK and talks to Coucou in JSON lines.
//
//   node coucou-agent.mjs --cwd ~/work --max-turns 20 --max-budget 1 "your task"
//
// Output (stdout, one JSON object per line):
//   {"type":"init","session_id":"…","model":"…"}
//   {"type":"text","text":"…"}
//   {"type":"tool_use","tool":"Bash","summary":"ls -la"}
//   {"type":"permission_request","id":"…","tool":"Bash","summary":"rm -rf …","input":{…}}
//   {"type":"result","ok":true,"text":"…","turns":3,"cost_usd":0.02}
//   {"type":"error","message":"…"}
//
// Input (stdin, one JSON object per line):
//   {"type":"permission_response","id":"…","decision":"allow"|"deny"}
//   {"type":"cancel"}
//
// Safety rules (see CLAUDE.md): nothing but read-only tools runs without an explicit
// allow from the user; no answer within the timeout means deny.

import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
const PERMISSION_TIMEOUT_MS = 110_000;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), maxTurns: 20, maxBudget: 1, model: undefined, prompt: "" };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") opts.cwd = argv[++i];
    else if (a === "--max-turns") opts.maxTurns = Number(argv[++i]);
    else if (a === "--max-budget") opts.maxBudget = Number(argv[++i]);
    else if (a === "--model") opts.model = argv[++i];
    else rest.push(a);
  }
  opts.cwd = resolve(opts.cwd.replace(/^~(?=$|\/)/, homedir()));
  opts.prompt = rest.join(" ").trim();
  return opts;
}

// Short, human-readable one-liner for the notch ticker.
function summarize(tool, input = {}) {
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? "";
  return String(v).slice(0, 120);
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.prompt) {
  emit({ type: "error", message: "No task given. Usage: coucou-agent.mjs [--cwd dir] \"task\"" });
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  emit({ type: "error", message: "ANTHROPIC_API_KEY is not set." });
  process.exit(2);
}

const abort = new AbortController();
const pending = new Map(); // permission request id -> resolve(decision)

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "permission_response" && pending.has(msg.id)) {
    pending.get(msg.id)(msg.decision === "allow" ? "allow" : "deny");
  } else if (msg.type === "cancel") {
    abort.abort();
  }
});
process.on("SIGTERM", () => abort.abort());
process.on("SIGINT", () => abort.abort());

async function canUseTool(toolName, input, { requestId, signal }) {
  const id = requestId;
  emit({ type: "permission_request", id, tool: toolName, summary: summarize(toolName, input), input });
  const decision = await new Promise((resolveDecision) => {
    const timer = setTimeout(() => resolveDecision("deny"), PERMISSION_TIMEOUT_MS);
    const done = (d) => { clearTimeout(timer); pending.delete(id); resolveDecision(d); };
    pending.set(id, done);
    signal?.addEventListener("abort", () => done("deny"), { once: true });
  });
  return decision === "allow"
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: "Denied by the user (or no answer in time)." };
}

try {
  const stream = query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      model: opts.model,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudget,
      permissionMode: "default",
      allowedTools: READ_ONLY_TOOLS, // auto-approved; everything else goes through canUseTool
      canUseTool,
      settingSources: [], // don't load ~/.claude settings: avoids double-reporting through nb-hook
      abortController: abort,
    },
  });

  for await (const m of stream) {
    if (m.type === "system" && m.subtype === "init") {
      emit({ type: "init", session_id: m.session_id, model: m.model, cwd: m.cwd });
    } else if (m.type === "assistant") {
      for (const block of m.message?.content ?? []) {
        if (block.type === "text" && block.text) emit({ type: "text", text: block.text });
        else if (block.type === "tool_use") {
          emit({ type: "tool_use", tool: block.name, summary: summarize(block.name, block.input) });
        }
      }
    } else if (m.type === "result") {
      emit({
        type: "result",
        ok: m.subtype === "success" && !m.is_error,
        text: typeof m.result === "string" ? m.result : "",
        subtype: m.subtype,
        turns: m.num_turns,
        cost_usd: m.total_cost_usd,
      });
    }
  }
} catch (err) {
  emit({ type: "error", message: abort.signal.aborted ? "Cancelled." : String(err?.message ?? err) });
  process.exitCode = 1;
} finally {
  rl.close();
}
