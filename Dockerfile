FROM node:20-bookworm-slim

WORKDIR /app

# Keep image lean and reproducible
ENV NODE_ENV=development

# Install dependencies first for better layer caching
COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && npm ci --no-audit --no-fund \
  && npm install -g vercel@latest --no-audit --no-fund \
  && apt-get purge -y --auto-remove python3 make g++ \
  && npm cache clean --force \
  && rm -rf /root/.npm /tmp/* /var/lib/apt/lists/*

# Copy source
COPY . .

# Default command is overridden per service in docker-compose.yml
CMD ["node", "--version"]
