# autogenous-service — Cloud Run image (the Autogenous AGL control-plane as a
# service). Multi-stage: build the release binary, ship it on a slim runtime.
FROM rust:1-bookworm AS builder
WORKDIR /build
# Copy the whole workspace (the service path-depends on agl-types).
COPY . .
RUN cargo build --release -p autogenous-service

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/autogenous-service /usr/local/bin/autogenous-service
# Cloud Run sets $PORT; the service defaults to 8080.
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/autogenous-service"]
