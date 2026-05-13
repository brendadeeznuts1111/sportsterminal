FROM oven/bun:1.3.13-alpine
WORKDIR /app
COPY package.json ./
RUN bun install --no-optional 2>/dev/null || bun install
COPY . .
RUN mkdir -p data logs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["bun", "run", "src/index.ts"]
