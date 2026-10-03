FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm install tsx@^4.19.0
COPY . .
ENV MCP_HTTP_PORT=8080
EXPOSE 8080
USER node
CMD ["npx", "tsx", "src/task-mcp-server.ts"]
