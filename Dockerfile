# Zero-dependency Bun app — no install step needed (only global fetch + Buffer).
FROM oven/bun:1.1-alpine

WORKDIR /app
COPY src ./src
# Static name-enrichment data (regenerated out-of-band by scripts/; see README). Committed to the
# repo so the image ships with them. The exporter treats them as optional at runtime.
COPY deployments.json indexers.json ./

ENV PORT=9090
EXPOSE 9090

# Drop to the image's unprivileged user.
USER bun

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||9090)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "run", "src/index.ts"]
