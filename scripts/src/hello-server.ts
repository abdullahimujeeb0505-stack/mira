import { createServer } from "node:http";

const port = Number(process.env.PORT) || 3000;

const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Hello");
});

server.listen(port);
