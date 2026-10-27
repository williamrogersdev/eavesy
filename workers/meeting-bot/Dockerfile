# Eavesy meeting bot: the Rust driver plus Chromium and a virtual display.
# Built for linux/amd64, the architecture Cloudflare Containers run.

FROM rust:1-bookworm AS build
WORKDIR /src
COPY bot/Cargo.toml bot/Cargo.lock ./
# Dependencies build once and stay cached while only our sources change.
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release --locked && rm -rf src
COPY bot/src ./src
RUN touch src/main.rs && cargo build --release --locked

FROM debian:bookworm-slim
# Headful Chromium under Xvfb, not --headless: the meeting apps treat a
# headless browser as unsupported, and a real window behaves like a guest's.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium xvfb fonts-liberation fonts-noto-color-emoji ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home bot
COPY --from=build /src/target/release/eavesy-bot /usr/local/bin/eavesy-bot
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
USER bot
ENV DISPLAY=:99 CHROME_PATH=/usr/bin/chromium CONTROL_PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
