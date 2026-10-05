// Runs only inside an owned evidence VM; no provider or production credentials.
const command = process.argv[2];
if (command !== "continue" && command !== "state" && command !== "refresh") throw new Error("Unknown evidence control");
// refresh: reload the app so it serves the frontend checked out over this world.
const response = await fetch(`http://127.0.0.1:6081/__evidence/${command}`, {
  method: command === "state" ? "GET" : "POST", signal: AbortSignal.timeout(command === "refresh" ? 180_000 : 5_000),
});
const text = await response.text();
if (!response.ok) throw new Error(`Evidence control ${command} failed: ${text.slice(0, 500)}`);
console.log(text);
