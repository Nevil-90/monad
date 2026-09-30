# Relay and keeper image (the web app is a static Next.js build; host it on any Next.js platform).
# Secrets are never baked in: pass them at run time (docker compose env_file, or your host's secrets).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src/config.js src/oracle.js src/rpc.js ./src/
COPY src/contracts/HouseAbi.js ./src/contracts/
COPY scripts/price_relay.js scripts/house_keeper.js ./scripts/
COPY scripts/lib ./scripts/lib
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
# Default: the relay. The keeper service overrides the command.
CMD ["node", "scripts/price_relay.js"]
