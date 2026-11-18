# Фронтенд (React)
FROM node:24-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

# Сервер
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
# Кэш зависимостей: собираем их отдельно от исходников
RUN mkdir src && echo 'fn main(){}' > src/main.rs && cargo build --release --locked && rm -rf src
COPY migrations ./migrations
COPY src ./src
RUN touch src/main.rs && cargo build --release --locked

# Рантайм
FROM debian:bookworm-slim
# ffmpeg — обработка аватаров и баннеров (кадрирование, размеры, WebP/MP4, удаление метаданных и звука)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 relay && mkdir -p /data && chown relay /data
COPY --from=build /src/target/release/relay /app/relay
COPY --from=web /web/dist /app/web
USER relay
ENV RELAY_ADDR=0.0.0.0:8080 RELAY_DATA=/data RELAY_WEB=/app/web
EXPOSE 8080
VOLUME /data
CMD ["/app/relay"]
