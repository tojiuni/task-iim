FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm install tsx
COPY . .
ENV MCP_HTTP_PORT=8080
EXPOSE 8080
CMD ["npx", "tsx", "src/goquest-mcp-server.ts"]
