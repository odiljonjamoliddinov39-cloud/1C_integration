# Control system API, with the admin dashboard (apps/admin) served at /admin/.
# Build from the repo root:  docker build -f apps/api/Dockerfile -t platform-api .
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @platform/api... --filter @platform/admin...
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/admin apps/admin
RUN pnpm --filter @platform/api build \
 && pnpm --filter @platform/admin build \
 && pnpm --filter @platform/api deploy --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/drizzle ./drizzle
COPY --from=build /repo/apps/admin/dist ./admin
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
