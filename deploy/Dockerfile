FROM rust:1-bookworm AS build

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY apps ./apps

# Build only the server binary.
RUN cargo build -p filedock-server --release

FROM debian:bookworm-slim

RUN useradd -m -u 10001 filedock
USER filedock

WORKDIR /app
COPY --from=build /src/target/release/filedock-server /app/filedock-server

EXPOSE 8787
ENV FILEDOCK_STORAGE_DIR=/data

CMD ["/app/filedock-server", "--listen", "0.0.0.0:8787"]

