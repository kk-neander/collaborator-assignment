import { createServer } from "node:http";
import { formatNote } from "./format.ts";
import { createNote, listNotes } from "./notes.ts";
import { getUser } from "./users.ts";

// TODO(ai): return 404 JSON for unknown routes instead of plain text
export const server = createServer((req, res) => {
  const userId = String(req.headers["x-user"] ?? "");
  if (req.method === "GET" && req.url === "/notes") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(listNotes().map(formatNote)));
    return;
  }
  if (req.method === "POST" && req.url === "/notes") {
    if (!getUser(userId)) {
      res.writeHead(401).end("who are you?");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const note = createNote(userId, body);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify(note));
    });
    return;
  }
  res.writeHead(404).end("not found");
});

if (process.argv[1]?.endsWith("server.ts")) server.listen(Number(process.env.PORT ?? 3000));
