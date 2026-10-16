import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";

async function availablePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

// Use the real executable so cancellation also stops the server, not just Bun's shim.
function executable() {
  const direct = join(homedir(), "node_modules", "opencode-ai", "bin", "opencode.exe");
  return process.platform === "win32" && existsSync(direct)
    ? direct : join(homedir(), ".bun", "bin", "opencode");
}

export async function runOpenCode(
  body: any, onEvent: (event: any) => void, signal?: AbortSignal,
  onQuestion?: (request: any, signal: AbortSignal) => Promise<string[][] | undefined>,
) {
  signal?.throwIfAborted();
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString("hex");
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    "content-type": "application/json",
  };
  const controller = new AbortController();
  const child = spawn(executable(), ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password },
  });
  let diagnostic = "";
  child.stdout.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
  child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
  child.once("error", error => controller.abort(error));
  child.once("exit", code => {
    if (!controller.signal.aborted) controller.abort(new Error(`OpenCode server exited (${code}): ${diagnostic}`));
  });
  const abort = () => controller.abort(signal?.reason ?? new Error("Request cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let sessionID: string | undefined;
  let eventTask: Promise<void> | undefined;
  const eventController = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const questions = new Set<string>();
  const questionTasks = new Set<Promise<void>>();
  const activity = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error("OpenCode: no progress for 10 minutes")), 600000);
  };
  const request = async (path: string, init: any = {}) => {
    const response = await fetch(base + path, { ...init, headers, signal: controller.signal });
    if (!response.ok) throw new Error(`OpenCode HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
    return response;
  };
  try {
    const deadline = Date.now() + 30000;
    while (true) {
      controller.signal.throwIfAborted();
      try {
        const response = await fetch(base + "/global/health", { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]) });
        if (response.ok && (await response.json()).healthy) break;
      } catch {}
      if (Date.now() >= deadline) throw new Error(`OpenCode server startup timed out: ${diagnostic}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    sessionID = (await (await request("/session", {
      method: "POST", body: JSON.stringify({ title: "pi adapter" }),
    })).json()).id;
    const events = await fetch(base + "/event", {
      headers, signal: AbortSignal.any([controller.signal, eventController.signal]),
    });
    if (!events.ok || !events.body) throw new Error(`OpenCode event subscription failed (${events.status})`);
    activity();
    eventTask = (async () => {
      let buffer = "";
      try {
        for await (const chunk of events.body!.pipeThrough(new TextDecoderStream())) {
          buffer = (buffer + chunk).replace(/\r\n/g, "\n");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const event = JSON.parse(data);
            const props = event.properties ?? {};
            if ((props.sessionID ?? props.part?.sessionID ?? props.info?.sessionID) !== sessionID) continue;
            activity();
            if (event.type === "session.error") throw new Error(JSON.stringify(props.error));
            if (event.type === "question.asked" || event.type === "question.v2.asked") {
              if (!questions.has(props.id)) {
                questions.add(props.id);
                const task = (async () => {
                  const answers = onQuestion ? await onQuestion(props, controller.signal) : undefined;
                  controller.signal.throwIfAborted();
                  const root = event.type === "question.v2.asked" ? `/api/session/${sessionID}/question` : "/question";
                  await request(`${root}/${encodeURIComponent(props.id)}/${answers === undefined ? "reject" : "reply"}`, {
                    method: "POST", ...(answers === undefined ? {} : { body: JSON.stringify({ answers }) }),
                  });
                  activity();
                })();
                questionTasks.add(task);
                void task.catch(error => { if (!controller.signal.aborted) controller.abort(error); }).finally(() => questionTasks.delete(task));
              }
              continue;
            }
            if (event.type === "permission.asked") {
              throw new Error(`OpenCode needs interactive input (${event.type}); open OpenCode to complete this operation.`);
            }
            onEvent(event);
          }
        }
        if (!eventController.signal.aborted) throw new Error("OpenCode event stream disconnected");
      } catch (error) {
        if (!eventController.signal.aborted && !controller.signal.aborted) controller.abort(error);
      }
    })();
    const result = await (await request(`/session/${sessionID}/message`, {
      method: "POST", body: JSON.stringify(body),
    })).json();
    if (result.info?.error) throw new Error(JSON.stringify(result.info.error));
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener("abort", abort);
    // The abort endpoint uses its own deadline after the request's signal is cancelled.
    if (sessionID && controller.signal.aborted) {
      await fetch(base + `/session/${sessionID}/abort`, {
        method: "POST", headers, signal: AbortSignal.timeout(2000),
      }).catch(() => {});
    }
    eventController.abort();
    await eventTask;
    if (sessionID) await fetch(base + `/session/${sessionID}`, {
      method: "DELETE", headers, signal: AbortSignal.timeout(2000),
    }).catch(() => {});
    controller.abort();
    await Promise.allSettled(questionTasks);
    if (child.pid && child.exitCode === null) {
      if (process.platform === "win32") {
        await new Promise<void>(resolve => execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
      } else child.kill();
    }
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
